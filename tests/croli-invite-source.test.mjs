import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { CroliAuthPlugin } from "../index.mjs"
import {
  ensureInvite,
  parseCroliInviteInput,
  resolveCroliInviteSource,
  writeReservedCroliInvite,
} from "../src/croli-account.mjs"

const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })
const fakeJwt = (sub) => `e30.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.sig`
const account = (uid) => ({ type: "oauth", access: `csk_${uid}`, uid, metadata: { userId: uid, croliAccessToken: fakeJwt(uid) } })

async function inviteFetch(url, init = {}) {
  let uid = "user_A"
  try {
    const token = new Headers(init.headers).get("authorization")?.split(" ")[1]
    uid = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub
  } catch {}
  const code = uid === "user_B" ? "Latest123" : "Preferred123"
  return String(url).includes("/v1/invite/code")
    ? json({ inviteCode: code, inviterRewardCredits: 2500, inviteeRewardCredits: 3000 })
    : json({ completedCount: 0, totalRewardCredits: 0 })
}

async function seedInvites() {
  const cacheDir = await mkdtemp(join(tmpdir(), "croli-invite-cache-"))
  const configDir = await mkdtemp(join(tmpdir(), "croli-invite-config-"))
  for (const [uid, at] of [["user_A", 1000], ["user_B", 2000]]) {
    await ensureInvite(account(uid), { cacheDir, now: () => at, fetchImpl: inviteFetch })
  }
  await writeFile(join(configDir, "logins.json"), JSON.stringify([{ agent: "plugin:croli", home: "croli", first: true }]))
  await writeFile(join(configDir, "plugin-auth.json"), JSON.stringify({ croli: account("user_A"), "croli-b": account("user_B") }))
  return { cacheDir, configDir }
}

const pluginOptions = (cacheDir, configDir, fetchImpl = inviteFetch) => ({ inviteCacheDir: cacheDir, magpieConfigDir: configDir, fetchImpl })

test("邀请输入只接受官方链接或码，拒绝外部 URL 与凭据", () => {
  assert.equal(parseCroliInviteInput("Abc_123").url, "https://www.croli.net/invite/?code=Abc_123")
  assert.equal(parseCroliInviteInput("https://www.croli.net/invite/?code=Abc_123").code, "Abc_123")
  assert.equal(parseCroliInviteInput("").automatic, true)
  assert.equal(parseCroliInviteInput("1").automatic, true)
  assert.equal(parseCroliInviteInput("https://attacker.invalid/?code=Abc_123").ok, false)
  assert.equal(parseCroliInviteInput("csk_secret").ok, false)
  assert.equal(parseCroliInviteInput("eyJabc.def.ghi").ok, false)
})

test("默认首选账号，关闭时最近账号，预留码不被自动覆盖", async () => {
  const { cacheDir, configDir } = await seedInvites()
  try {
    const preferred = resolveCroliInviteSource({ preferFirst: true, cacheDir, configDir })
    assert.equal(preferred.kind, "preferred")
    assert.equal(preferred.code, "Preferred123")
    const latest = resolveCroliInviteSource({ preferFirst: false, cacheDir, configDir })
    assert.equal(latest.kind, "latest")
    assert.equal(latest.code, "Latest123")

    writeReservedCroliInvite("Reserved123", { cacheDir, now: () => 3000 })
    resolveCroliInviteSource({ preferFirst: true, cacheDir, configDir })
    resolveCroliInviteSource({ preferFirst: false, cacheDir, configDir })
    const reservedFile = JSON.parse(await readFile(join(cacheDir, "croli-invite.json"), "utf8"))
    assert.equal(reservedFile.code, "Reserved123")
    assert.equal(reservedFile.source, "chosen")

    const fallback = resolveCroliInviteSource({ preferFirst: true, preferredUid: "missing", cacheDir, configDir })
    assert.equal(fallback.kind, "reserved")
    assert.equal(fallback.code, "Reserved123")
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})

test("登录第一问是邀请来源 select，默认首选账号且 authorize 零网络", async () => {
  const { cacheDir, configDir } = await seedInvites()
  let calls = 0
  const countingFetch = async (...args) => { calls++; return inviteFetch(...args) }
  try {
    const plugin = await CroliAuthPlugin({}, pluginOptions(cacheDir, configDir, countingFetch))
    const method = plugin.auth.methods[1]
    assert.equal(method.prompts[0].type, "select")
    assert.equal(method.prompts[0].options[0].value, "user_A")
    const prompt = await method.ask({})
    assert.equal(prompt.type, "select")
    assert.equal(prompt.key, "inviteSource")
    assert.equal(prompt.options[0].value, "user_A")
    assert.ok(prompt.options.some((option) => option.value === "latest"))
    assert.ok(prompt.options.some((option) => option.value === "manual"))
    assert.equal(await method.ask({ inviteSource: "user_A" }), null)
    const before = calls
    const result = await method.authorize(undefined)
    assert.equal(calls, before, "authorize 不重新取码或重新选账号")
    assert.equal(result.url, "https://www.croli.net/invite/?code=Preferred123")
    assert.match(result.instructions, /仅新注册账号有效/)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})

test("指定账号取自己的码并记住选择，下一次仍排第一", async () => {
  const { cacheDir, configDir } = await seedInvites()
  try {
    const plugin = await CroliAuthPlugin({}, pluginOptions(cacheDir, configDir))
    const method = plugin.auth.methods[1]
    await method.ask({})
    assert.equal(await method.ask({ inviteSource: "user_B" }), null)
    assert.equal((await method.authorize(undefined)).url, "https://www.croli.net/invite/?code=Latest123")
    assert.equal(JSON.parse(await readFile(join(cacheDir, "croli-invite-source.json"), "utf8")).code, "user_B")

    const next = await CroliAuthPlugin({}, pluginOptions(cacheDir, configDir))
    assert.equal(next.auth.methods[1].prompts[0].options[0].value, "user_B")
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})

test("显式选择 latest 记住的是滚动策略而不是当前账号", async () => {
  const { cacheDir, configDir } = await seedInvites()
  try {
    const plugin = await CroliAuthPlugin({}, pluginOptions(cacheDir, configDir))
    const method = plugin.auth.methods[1]
    await method.ask({})
    assert.equal(await method.ask({ inviteSource: "latest" }), null)
    assert.equal((await method.authorize(undefined)).url, "https://www.croli.net/invite/?code=Latest123")
    assert.equal(JSON.parse(await readFile(join(cacheDir, "croli-invite-source.json"), "utf8")).code, "latest")
    const next = await CroliAuthPlugin({}, pluginOptions(cacheDir, configDir))
    assert.equal(next.auth.methods[1].prompts[0].options[0].value, "latest")
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})

test("关闭首选开关后不提问，自动使用最新账号", async () => {
  const { cacheDir, configDir } = await seedInvites()
  try {
    const plugin = await CroliAuthPlugin({ magpie: { option: () => false } }, pluginOptions(cacheDir, configDir))
    const method = plugin.auth.methods[1]
    assert.deepEqual(method.prompts, [])
    assert.equal(await method.ask({}), null)
    assert.equal((await method.authorize(undefined)).url, "https://www.croli.net/invite/?code=Latest123")
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})

test("手动分支才问邀请码并记住，非法输入不会进入注册链接", async () => {
  const { cacheDir, configDir } = await seedInvites()
  try {
    const plugin = await CroliAuthPlugin({}, pluginOptions(cacheDir, configDir))
    const method = plugin.auth.methods[1]
    await method.ask({})
    assert.equal((await method.ask({ inviteSource: "manual" })).key, "invite")
    assert.equal(await method.ask({ inviteSource: "manual", invite: "Manual123" }), null)
    assert.equal((await method.authorize(undefined)).url, "https://www.croli.net/invite/?code=Manual123")
    assert.equal(JSON.parse(await readFile(join(cacheDir, "croli-invite.json"), "utf8")).code, "Manual123")
    assert.equal(JSON.parse(await readFile(join(cacheDir, "croli-invite-source.json"), "utf8")).code, "manual")
    const remembered = await CroliAuthPlugin({}, pluginOptions(cacheDir, configDir))
    assert.equal(remembered.auth.methods[1].prompts[0].options[0].value, "manual")

    const invalidPlugin = await CroliAuthPlugin({}, pluginOptions(cacheDir, configDir))
    const invalidMethod = invalidPlugin.auth.methods[1]
    await invalidMethod.ask({})
    await invalidMethod.ask({ inviteSource: "manual" })
    const retry = await invalidMethod.ask({ inviteSource: "manual", invite: "https://attacker.invalid/?code=bad" })
    assert.match(retry.message, /官方 https 邀请地址/)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  }
})
