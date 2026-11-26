import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MODEL_SPECS, RELAY_SEARCH } from "../src/croli.mjs"
import {
  CLERK_TOKEN_URL,
  OPS_HOME_URL,
  OPS_CHECKIN_URL,
  OPS_EVENTS_URL,
  INVITE_CODE_URL,
  INVITE_LIST_URL,
  buildInviteUrl,
  ensureInvite,
  checkinToday,
  recordDailyConversation,
  refreshAccount,
  trackConversation,
} from "../src/croli-account.mjs"

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
const fakeJwt = (payload = {}) => [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify(payload)).toString("base64url"),
  "signature",
].join(".")
const account = () => ({ type: "oauth", access: "csk_test", refresh: "refresh_old", uid: "user_test", metadata: { userId: "user_test", croliAccessToken: fakeJwt({ sub: "user_test" }) } })
const tasksHome = (key, status = "in_progress") => ({ enabled: true, programs: [{ tasks: [{
  id: key === "daily-checkin" ? 1 : 2,
  key,
  status,
  eventKey: key === "daily-checkin" ? "checkin" : "agent_turn_completed",
  periodKey: "2026-11-20",
  claimMode: "auto",
  milestones: [{ index: 0, count: 1, credits: key === "daily-checkin" ? 100 : 200, status: status === "claimed" ? "claimed" : "locked" }],
  ...(key === "daily-checkin" ? { streak: { current: 1, longest: 1 } } : {}),
}] }] })

test("邀请 URL 使用官方格式并拒绝坏码", () => {
  assert.equal(buildInviteUrl("ABC_def-123"), "https://www.croli.net/invite/?code=ABC_def-123")
  assert.throws(() => buildInviteUrl("bad code"), /邀请码形状无效/)
})

test("邀请固定 rotate:false，缓存不含 token，第二次走本地缓存", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "croli-invite-test-"))
  const auth = account()
  const calls = []
  try {
    const first = await ensureInvite(auth, {
      cacheDir,
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        if (url === INVITE_CODE_URL) return json({ inviteCode: "Invite123", inviterRewardCredits: 2500, inviteeRewardCredits: 3000 })
        if (url === INVITE_LIST_URL) return json({ items: [], completedCount: 0, totalRewardCredits: 0 })
        throw new Error(`unexpected ${url}`)
      },
    })
    assert.equal(first.url, "https://www.croli.net/invite/?code=Invite123")
    assert.equal(first.fromCache, false)
    assert.equal(calls.length, 2)
    const codeCall = calls.find((call) => call.url === INVITE_CODE_URL)
    assert.deepEqual(JSON.parse(codeCall.init.body), { rotate: false })
    assert.equal(codeCall.init.headers.authorization, `Bearer ${auth.metadata.croliAccessToken}`)
    const second = await ensureInvite(auth, { cacheDir, fetchImpl: async () => { throw new Error("不应联网") } })
    assert.equal(second.fromCache, true)
    assert.equal(calls.length, 2)
    const files = (await readdir(cacheDir)).filter((name) => name.startsWith("croli-invite-") && name !== "croli-invite-accounts.json")
    assert.equal(files.length, 1)
    const stored = await readFile(join(cacheDir, files[0]), "utf8")
    assert.ok(!stored.includes(auth.metadata.croliAccessToken))
    assert.ok(!stored.includes("refresh_old"))
    assert.ok(!stored.includes("csk_test"))
    assert.ok(!stored.includes("accessToken") && !stored.includes("refreshToken"))
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test("签到：已领取时不发 POST，新领取返回 creditsAwarded", async () => {
  const auth = account()
  let calls = 0
  const done = await checkinToday(auth, { fetchImpl: async () => { calls++; return json(tasksHome("daily-checkin", "claimed")) } })
  assert.equal(done.outcome, "done")
  assert.equal(calls, 1)

  const seen = []
  const claimed = await checkinToday(auth, {
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      if (url === OPS_HOME_URL) return json(tasksHome("daily-checkin"))
      if (url === OPS_CHECKIN_URL) return json({ alreadyCheckedIn: false, creditsAwarded: 100, streak: { current: 1, longest: 1 } })
      throw new Error(`unexpected ${url}`)
    },
  })
  assert.equal(claimed.outcome, "claimed")
  assert.equal(claimed.credit, 100)
  assert.deepEqual(JSON.parse(seen.find((call) => call.url === OPS_CHECKIN_URL).init.body), { taskId: 1 })
})

test("每日首聊按账号与周期幂等上报，且不带 token 到 metadata", async () => {
  const auth = account()
  let homeCalls = 0
  let eventBody
  const result = await recordDailyConversation(auth, "DeepSeek-V4.1-Flash", {
    fetchImpl: async (url, init) => {
      if (url === OPS_HOME_URL) {
        homeCalls++
        return json(tasksHome("daily-first-chat", homeCalls === 1 ? "in_progress" : "claimed"))
      }
      if (url === OPS_EVENTS_URL) {
        eventBody = JSON.parse(init.body)
        return json({ recorded: true })
      }
      throw new Error(`unexpected ${url}`)
    },
  })
  assert.equal(result.status, "claimed")
  assert.equal(result.credit, 200)
  assert.equal(eventBody.eventKey, "agent_turn_completed")
  assert.match(eventBody.eventId, /^magpie-croli-[a-f0-9]{12}-2026-11-20$/)
  assert.deepEqual(eventBody.metadata, { source: "magpie-croli", model: "DeepSeek-V4.1-Flash" })
  assert.ok(!JSON.stringify(eventBody).includes(auth.metadata.croliAccessToken))
  assert.ok(!JSON.stringify(eventBody).includes(auth.refresh))
})

test("SSE 只有完整读完后才上报，字节内容不变", async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: one\n\n"))
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  let completed = 0
  const response = trackConversation(new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } }), async () => { completed++ })
  assert.equal(completed, 0)
  assert.equal(await response.text(), "data: one\n\ndata: [DONE]\n\n")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, 1)
})

test("截断 SSE 没有终止标记时不上报每日任务", async () => {
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: partial\n\n"))
      controller.close()
    },
  })
  let completed = 0
  const response = trackConversation(new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } }), async () => { completed++ })
  assert.equal(await response.text(), "data: partial\n\n")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, 0)
})

test("finish_reason:null 与 stop_reason:null 的截断流不上报", async () => {
  for (const marker of ['"finish_reason":null', '"stop_reason":null']) {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: {${marker}}\n\n`))
        controller.close()
      },
    })
    let completed = 0
    const response = trackConversation(new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } }), async () => { completed++ })
    await response.text()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(completed, 0, marker)
  }
})

test("非流式用 clone 验证 choices，原响应仍可读", async () => {
  let completed = 0
  const response = trackConversation(json({ choices: [{ message: { content: "OK" } }] }), async () => { completed++ })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, 1)
  assert.deepEqual(await response.json(), { choices: [{ message: { content: "OK" } }] })
})

test("Clerk 刷新只发送三项表单并合并新网关 Key 与 metadata", async () => {
  const auth = account()
  const nextJwt = fakeJwt({ sub: "user_test", exp: 2_000_000_000 })
  let form
  const result = await refreshAccount(auth, {
    now: () => 1_700_000_000_000,
    fetchImpl: async (url, init) => {
      if (url === CLERK_TOKEN_URL) {
        form = init.body
        assert.equal(init.headers["content-type"], "application/x-www-form-urlencoded")
        return json({ access_token: nextJwt, refresh_token: "refresh_new", expires_in: 3600, token_type: "Bearer" })
      }
      if (url === RELAY_SEARCH) return json({ resources: [{ url: "https://ds.croli.net/v1", sk: "csk_new", models: MODEL_SPECS.map((spec) => spec.id) }] })
      throw new Error(`unexpected ${url}`)
    },
  })
  const params = new URLSearchParams(form)
  assert.deepEqual([...params.keys()].sort(), ["client_id", "grant_type", "refresh_token"])
  assert.equal(params.get("refresh_token"), "refresh_old")
  assert.equal(params.get("client_secret"), null)
  assert.equal(result.access, "csk_new")
  assert.equal(result.refresh, "refresh_new")
  assert.equal(result.expires, 1_700_003_600_000)
  assert.equal(result.metadata.userId, "user_test")
  assert.equal(result.metadata.croliAccessToken, nextJwt)
})

test("旧 refresh token invalid_grant 时仅用桌面端更新的 token 重试一次", async () => {
  const dir = await mkdtemp(join(tmpdir(), "croli-refresh-test-"))
  const file = join(dir, "auth.json")
  const nextJwt = fakeJwt({ sub: "user_test" })
  const clerkBodies = []
  try {
    await writeFile(file, JSON.stringify({ access_token: fakeJwt({ sub: "user_test" }), refresh_token: "refresh_from_desktop" }))
    const result = await refreshAccount(account(), {
      env: { CROLI_AUTH_FILE: file },
      fetchImpl: async (url, init) => {
        if (url === CLERK_TOKEN_URL) {
          clerkBodies.push(init.body)
          if (clerkBodies.length === 1) return json({ error: "invalid_grant" }, 400)
          return json({ access_token: nextJwt, refresh_token: "refresh_rotated", expires_in: 3600 })
        }
        if (url === RELAY_SEARCH) return json({ resources: [{ url: "https://ds.croli.net/v1", sk: "csk_retry", models: MODEL_SPECS.map((spec) => spec.id) }] })
        throw new Error(`unexpected ${url}`)
      },
    })
    assert.equal(clerkBodies.length, 2)
    assert.match(clerkBodies[0], /refresh_old/)
    assert.match(clerkBodies[1], /refresh_from_desktop/)
    assert.equal(result.refresh, "refresh_rotated")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("桌面端是 B 账号时拒绝把 B 的凭证合并进 A", async () => {
  const dir = await mkdtemp(join(tmpdir(), "croli-refresh-ab-test-"))
  const file = join(dir, "auth.json")
  let clerkCalls = 0
  let relayCalls = 0
  try {
    await writeFile(file, JSON.stringify({ access_token: fakeJwt({ sub: "user_B" }), refresh_token: "refresh_B" }))
    await assert.rejects(
      () => refreshAccount(account(), {
        env: { CROLI_AUTH_FILE: file },
        fetchImpl: async (url) => {
          if (url === CLERK_TOKEN_URL) {
            clerkCalls++
            return json({ error: "invalid_grant" }, 400)
          }
          if (url === RELAY_SEARCH) relayCalls++
          throw new Error(`unexpected ${url}`)
        },
      }),
      (error) => error.status === 409 && /不一致/.test(error.message),
    )
    assert.equal(clerkCalls, 1)
    assert.equal(relayCalls, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("无 refresh 且桌面是 B 时在任何网络请求前拒绝", async () => {
  const dir = await mkdtemp(join(tmpdir(), "croli-no-refresh-ab-test-"))
  const file = join(dir, "auth.json")
  let networkCalls = 0
  try {
    await writeFile(file, JSON.stringify({ access_token: fakeJwt({ sub: "user_B" }), refresh_token: "refresh_B" }))
    const auth = account()
    delete auth.refresh
    await assert.rejects(
      () => refreshAccount(auth, {
        env: { CROLI_AUTH_FILE: file },
        fetchImpl: async () => { networkCalls++; throw new Error("不应发出网络请求") },
      }),
      (error) => error.status === 409 && /桌面登录账号/.test(error.message),
    )
    assert.equal(networkCalls, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("Clerk 返回不同 sub 时在 relay 前拒绝合并", async () => {
  let relayCalls = 0
  await assert.rejects(
    () => refreshAccount(account(), {
      fetchImpl: async (url) => {
        if (url === CLERK_TOKEN_URL) return json({ access_token: fakeJwt({ sub: "user_B" }), refresh_token: "refresh_new", expires_in: 3600 })
        if (url === RELAY_SEARCH) relayCalls++
        throw new Error(`unexpected ${url}`)
      },
    }),
    (error) => error.status === 409 && /续期返回账号/.test(error.message),
  )
  assert.equal(relayCalls, 0)
})

test("被污染的邀请缓存按白名单读取并重建官方 URL", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "croli-invite-poison-test-"))
  try {
    const auth = account()
    const first = await ensureInvite(auth, {
      cacheDir,
      fetchImpl: async (url) => url === INVITE_CODE_URL
        ? json({ inviteCode: "SafeCode123", inviterRewardCredits: 2500, inviteeRewardCredits: 3000 })
        : json({ completedCount: 0, totalRewardCredits: 0 }),
    })
    assert.equal(first.code, "SafeCode123")
    const [file] = (await readdir(cacheDir)).filter((name) => name.startsWith("croli-invite-") && name !== "croli-invite-accounts.json")
    const poisoned = {
      ...JSON.parse(await readFile(join(cacheDir, file), "utf8")),
      accessToken: "leaked_access",
      refreshToken: "leaked_refresh",
      url: "https://attacker.invalid/?token=leaked_access",
      updatedAt: Date.now(),
    }
    await writeFile(join(cacheDir, file), JSON.stringify(poisoned))
    const result = await ensureInvite(auth, { cacheDir, fetchImpl: async () => { throw new Error("不应联网") } })
    assert.equal(result.url, "https://www.croli.net/invite/?code=SafeCode123")
    assert.equal(result.accessToken, undefined)
    assert.equal(result.refreshToken, undefined)
    assert.ok(!JSON.stringify(result).includes("leaked_"))
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
})
