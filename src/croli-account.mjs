// Croli 账户能力：Clerk 续期、每日任务、邀请码与真实对话完成上报。
// 秘密只存在 magpie 凭证对象内；邀请缓存只保存可公开的 code / URL / 奖励统计。
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { fingerprint } from "./credential.mjs"
import { CODES, OFFICIAL_UA, errorText, readBody } from "./http.mjs"
import { readJson, writeJson } from "./store.mjs"
import { PROVIDER, defaultCroliAuthFiles, exchangeRelayKey, importDesktopKey } from "./croli.mjs"
import { readPreferredUid } from "./preferred.mjs"

export const CLERK_TOKEN_URL = "https://clerk.croli.net/oauth/token"
export const CLERK_CLIENT_ID = "znV4SkcUsY1AektQ"
export const CREDITS_BASE = "https://ds.croli.net/credits"
export const OPS_HOME_URL = `${CREDITS_BASE}/v1/ops/home`
export const OPS_CHECKIN_URL = `${CREDITS_BASE}/v1/ops/checkin`
export const OPS_EVENTS_URL = `${CREDITS_BASE}/v1/ops/events`
export const INVITE_CODE_URL = `${CREDITS_BASE}/v1/invite/code`
export const INVITE_LIST_URL = `${CREDITS_BASE}/v1/invite/list?limit=1`
export const INVITE_PAGE = "https://www.croli.net/invite/"

function fail(message, status, code, extra = {}) {
  return Object.assign(new Error(String(message)), { status, code, ...extra })
}

function secret(value) {
  const text = String(value ?? "").trim()
  return text && text.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(text) ? text : ""
}

function accountJwt(auth) {
  return secret(auth?.metadata?.croliAccessToken)
}

function jwtSub(token) {
  try {
    const part = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")
    const payload = JSON.parse(Buffer.from(part, "base64").toString("utf8"))
    return secret(payload.sub)
  } catch {
    return ""
  }
}

function expectedUid(auth) {
  return secret(auth?.metadata?.userId || auth?.uid)
}

function assertUidMatch(auth, candidateSub, source) {
  const expected = expectedUid(auth)
  if (!expected) throw fail("当前 Croli 账号缺少 userId，已阻止凭证回退；请重新一次性导入", 401, CODES.signInRequired)
  if (!candidateSub || candidateSub !== expected) {
    throw fail(`${source}与当前 Croli 账号不一致，已阻止跨账号凭证合并`, 409, CODES.concurrencyConflict)
  }
}

async function requestJson(url, { method = "GET", key = "", body, form, fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        "user-agent": OFFICIAL_UA,
        accept: "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(form ? { body: form.toString() } : body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    })
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError"
    throw fail(`Croli 账户接口${timeout ? "超时" : "网络错误"}：${error?.message ?? error}`, timeout ? 504 : 503, timeout ? CODES.upstreamTimeout : CODES.upstreamUnavailable)
  }
  const data = await readBody(response)
  if (!response.ok) {
    const vendorCode = data?.error || data?.code || data?.error?.code || ""
    throw fail(errorText(data) || `Croli 账户接口 HTTP ${response.status}`, response.status, data?.error?.code || data?.code || CODES.upstreamError, { data, vendorCode })
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || data._text) {
    throw fail("Croli 账户接口没有返回有效 JSON", 502, CODES.upstreamError)
  }
  return data
}

async function readDesktopAuth(env) {
  for (const file of defaultCroliAuthFiles(env)) {
    try {
      const value = JSON.parse(await readFile(file, "utf8"))
      if (value && typeof value === "object") return value
    } catch {}
  }
  return {}
}

function importedRecord(imported, auth, now) {
  const expires = Number(imported.expiresAt) || now()
  return {
    access: imported.key,
    refresh: imported.refreshToken || secret(auth?.refresh),
    expires,
    metadata: {
      ...(auth?.metadata ?? {}),
      ...imported.metadata,
    },
  }
}

/** 由 magpie auth.refresh 调用；只有 invalid_grant 才标登录失效，网络错误保留账号。 */
export async function refreshAccount(auth, { fetchImpl = fetch, env = process.env, now = Date.now } = {}) {
  if (!auth || auth.type === "api") return undefined
  if (!expectedUid(auth)) throw fail("当前 Croli 账号缺少 userId，已阻止凭证回退；请重新一次性导入", 401, CODES.signInRequired)
  const desktop = await readDesktopAuth(env)
  const desktopSub = jwtSub(desktop.access_token)
  const desktopAllowed = desktopSub && desktopSub === expectedUid(auth)
  let token = secret(auth.refresh)
  if (!token && desktopAllowed) token = secret(desktop.refresh_token)
  if (!token) {
    // 先在本地验证账号，再允许 importDesktopKey 进入 relay，避免任何 A/B 交换请求。
    assertUidMatch(auth, desktopSub, "桌面登录账号")
    const imported = await importDesktopKey({ fetchImpl, env })
    assertUidMatch(auth, imported.uid, "桌面登录账号")
    return importedRecord(imported, auth, now)
  }

  async function exchange(refreshToken) {
    return requestJson(CLERK_TOKEN_URL, {
      method: "POST",
      form: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLERK_CLIENT_ID,
        refresh_token: refreshToken,
      }),
      fetchImpl,
    })
  }

  let renewed
  try {
    renewed = await exchange(token)
  } catch (error) {
    const desktopToken = secret(desktop.refresh_token)
    if (error?.vendorCode !== "invalid_grant") throw error
    // 官方客户端可能刚轮换过；只在其文件提供了不同 token 时重试一次。
    if (desktopToken && desktopToken !== token && desktopAllowed) {
      token = desktopToken
      try {
        renewed = await exchange(token)
      } catch (retryError) {
        if (retryError?.vendorCode === "invalid_grant") retryError.signIn = "expired"
        throw retryError
      }
    } else {
      if (desktopToken && desktopToken !== token && !desktopAllowed) assertUidMatch(auth, desktopSub, "桌面登录账号")
      error.signIn = "expired"
      throw error
    }
  }

  const jwt = secret(renewed.access_token)
  const expiresIn = Number(renewed.expires_in)
  if (!jwt || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw fail("Clerk 刷新响应缺少 access_token 或有效 expires_in", 502, CODES.upstreamError)
  }
  assertUidMatch(auth, jwtSub(jwt), "Clerk 续期返回账号")
  const relay = await exchangeRelayKey(jwt, { fetchImpl })
  const expires = now() + expiresIn * 1000
  return {
    access: relay.key,
    refresh: secret(renewed.refresh_token) || token,
    expires,
    metadata: {
      ...(auth.metadata ?? {}),
      kind: "croli-gateway-key",
      croliAccessToken: jwt,
      croliExpiresAt: new Date(expires).toISOString(),
    },
  }
}

export async function fetchOpsHome(auth, { fetchImpl = fetch } = {}) {
  const jwt = accountJwt(auth)
  if (!jwt) throw fail("纯 API Key 没有账户任务凭证；请重新一次性导入", 401, CODES.signInRequired)
  return requestJson(OPS_HOME_URL, { key: jwt, fetchImpl })
}

export function findTask(home, key) {
  for (const program of home?.programs ?? []) {
    for (const task of program?.tasks ?? []) if (task?.key === key) return task
  }
  return null
}

function taskDone(task) {
  if (["claimed", "completed", "complete", "done"].includes(String(task?.status ?? ""))) return true
  return (task?.milestones ?? []).some((m) => ["claimed", "completed", "done"].includes(String(m?.status ?? "")))
}

function rewardOf(task) {
  return Number(task?.milestones?.find((m) => Number(m?.index) === 0)?.credits ?? 0)
}

export async function checkinToday(auth, { fetchImpl = fetch } = {}) {
  const home = await fetchOpsHome(auth, { fetchImpl })
  const task = findTask(home, "daily-checkin")
  if (!task) return { outcome: "ineligible", message: "当前账户没有每日签到任务" }
  if (taskDone(task)) {
    return { outcome: "done", credit: 0, streak: task.streak ?? undefined, message: `今日已签到 · 连续 ${task.streak?.current ?? 0} 天` }
  }
  const result = await requestJson(OPS_CHECKIN_URL, {
    method: "POST",
    key: accountJwt(auth),
    body: { taskId: task.id },
    fetchImpl,
  })
  const credit = Number(result.creditsAwarded ?? 0)
  if (result.alreadyCheckedIn === true) {
    return { outcome: "done", credit: 0, streak: result.streak ?? undefined, message: `今日已签到 · 连续 ${result.streak?.current ?? 0} 天` }
  }
  if (!Number.isFinite(credit) || credit < 0) throw fail("签到响应缺少有效 creditsAwarded", 502, CODES.upstreamError)
  return {
    outcome: "claimed",
    credit,
    streak: result.streak ?? undefined,
    message: `今日签到 +${credit} 积分 · 连续 ${result.streak?.current ?? 0} 天`,
  }
}

/** 只有真实对话完成后才调用；eventId 按账号 + 周期幂等。 */
export async function recordDailyConversation(auth, model, { fetchImpl = fetch } = {}) {
  const home = await fetchOpsHome(auth, { fetchImpl })
  const task = findTask(home, "daily-first-chat")
  if (!task) return { ok: false, status: "ineligible" }
  if (taskDone(task)) return { ok: true, status: "done", credit: 0 }
  const identity = String(auth?.metadata?.userId || auth?.uid || auth?.access || auth?.key || "account")
  const eventId = `magpie-croli-${fingerprint(identity)}-${task.periodKey}`
  await requestJson(OPS_EVENTS_URL, {
    method: "POST",
    key: accountJwt(auth),
    body: {
      eventKey: task.eventKey,
      eventId,
      metadata: { source: "magpie-croli", model: String(model || "unknown").slice(0, 128) },
    },
    fetchImpl,
  })
  let after = await fetchOpsHome(auth, { fetchImpl })
  let current = findTask(after, "daily-first-chat")
  if (!taskDone(current) && current?.status === "claimable") {
    await requestJson(`${CREDITS_BASE}/v1/ops/tasks/${current.id}/claim`, {
      method: "POST",
      key: accountJwt(auth),
      body: { milestoneIndex: 0, periodKey: current.periodKey },
      fetchImpl,
    })
    after = await fetchOpsHome(auth, { fetchImpl })
    current = findTask(after, "daily-first-chat")
  }
  return taskDone(current)
    ? { ok: true, status: "claimed", credit: rewardOf(current) }
    : { ok: true, status: "reported", credit: 0 }
}

export function buildInviteUrl(code) {
  const value = String(code ?? "").trim()
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(value)) throw fail("Croli 邀请码形状无效", 502, CODES.upstreamError)
  const url = new URL(INVITE_PAGE)
  url.searchParams.set("code", value)
  return url.toString()
}

function inviteCacheFile(uid, cacheDir) {
  return join(cacheDir, `croli-invite-${fingerprint(uid)}.json`)
}

function readInviteCache(file) {
  const cached = readJson(file, null)
  if (!cached || typeof cached !== "object" || !/^[A-Za-z0-9_-]{4,128}$/.test(String(cached.code ?? ""))) return null
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0
  return {
    code: String(cached.code),
    url: buildInviteUrl(cached.code),
    inviterRewardCredits: number(cached.inviterRewardCredits),
    inviteeRewardCredits: number(cached.inviteeRewardCredits),
    completedCount: number(cached.completedCount),
    totalRewardCredits: number(cached.totalRewardCredits),
    updatedAt: number(cached.updatedAt),
  }
}

export function parseCroliInviteInput(value) {
  const raw = String(value ?? "").trim()
  if (!raw || raw === "0" || raw === "1") return { ok: true, code: "", url: "", automatic: true }
  let code = raw
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== "https:" || !["www.croli.net", "croli.net"].includes(parsed.hostname) || !["/invite", "/invite/"].includes(parsed.pathname)) {
        return { ok: false, reason: "邀请链接必须是 Croli 官方 https 邀请地址" }
      }
      code = String(parsed.searchParams.get("code") ?? "").trim()
    } catch {
      return { ok: false, reason: "邀请链接格式无效" }
    }
  }
  if (/^(?:csk_|eyJ|bearer\s|refresh[_-]|access[_-])/i.test(code)) return { ok: false, reason: "这里只能填写邀请码，不能填写 token 或网关 Key" }
  try {
    return { ok: true, code, url: buildInviteUrl(code), automatic: false }
  } catch {
    return { ok: false, reason: "邀请码格式无效" }
  }
}

function inviteAccountsFile(cacheDir) {
  return join(cacheDir, "croli-invite-accounts.json")
}

/** 只记录稳定 uid 与首次/最近见到时间；不写显示名、token 或邀请码。 */
export function noteCroliAccount(auth, { cacheDir = join(homedir(), ".cache", "magpie"), now = Date.now } = {}) {
  const uid = String(auth?.metadata?.userId || "").trim()
  if (!uid) return null
  const file = inviteAccountsFile(cacheDir)
  const accounts = readJson(file, {})
  const valid = accounts && typeof accounts === "object" && !Array.isArray(accounts) ? accounts : {}
  const previous = valid[uid] && typeof valid[uid] === "object" ? valid[uid] : {}
  const at = Math.trunc(Number(now()))
  valid[uid] = {
    firstSeenAt: Number(previous.firstSeenAt) > 0 ? Number(previous.firstSeenAt) : at,
    lastSeenAt: Math.max(Number(previous.lastSeenAt) || 0, at),
  }
  writeJson(file, valid)
  return { uid, ...valid[uid] }
}

export function writeReservedCroliInvite(value, { cacheDir = join(homedir(), ".cache", "magpie"), now = Date.now } = {}) {
  const parsed = parseCroliInviteInput(value)
  if (!parsed.ok || parsed.automatic || !parsed.code) return null
  const file = join(cacheDir, "croli-invite.json")
  const entry = { code: parsed.code, source: "chosen", at: Math.trunc(Number(now())) }
  writeJson(file, entry)
  return { ...entry, url: parsed.url }
}

function reservedInvite(cacheDir) {
  const entry = readJson(join(cacheDir, "croli-invite.json"), null)
  const parsed = parseCroliInviteInput(entry?.code)
  return parsed.ok && parsed.code ? { ...parsed, kind: "reserved", uid: "" } : null
}

/** 登录选择器只在这里读取宿主 auth；auth 对象不落盘、不进 prompt。 */
export function readCroliInviteAccounts({ cacheDir = join(homedir(), ".cache", "magpie"), configDir = join(homedir(), ".config", "magpie") } = {}) {
  const document = readJson(join(configDir, "plugin-auth.json"), {})
  const seen = readJson(inviteAccountsFile(cacheDir), {})
  const rows = []
  for (const [home, auth] of Object.entries(document && typeof document === "object" && !Array.isArray(document) ? document : {})) {
    const uid = String(auth?.metadata?.userId || "").trim()
    if (!uid || !accountJwt(auth)) continue
    rows.push({
      uid,
      home,
      auth,
      accountId: String(auth?.accountId || "").trim(),
      firstSeenAt: Number(seen?.[uid]?.firstSeenAt) || 0,
      lastSeenAt: Number(seen?.[uid]?.lastSeenAt) || 0,
    })
  }
  rows.sort((a, b) => b.firstSeenAt - a.firstSeenAt || b.lastSeenAt - a.lastSeenAt || a.home.localeCompare(b.home))
  return rows.map((row, index) => ({ ...row, label: row.accountId || `Croli 账号 ${index + 1}` }))
}

export function readCroliInviteSelection(cacheDir = join(homedir(), ".cache", "magpie")) {
  const entry = readJson(join(cacheDir, "croli-invite-source.json"), null)
  return String(entry?.code || "").trim()
}

export function writeCroliInviteSelection(selection, { cacheDir = join(homedir(), ".cache", "magpie"), now = Date.now } = {}) {
  const code = String(selection || "").trim()
  if (!code) return null
  const entry = { code, source: "chosen", at: Math.trunc(Number(now())) }
  writeJson(join(cacheDir, "croli-invite-source.json"), entry)
  return entry
}

/** 默认只用 magpie 首选账号；关闭时使用最近首次见到的账号；最后才回手动预留码。 */
export function resolveCroliInviteSource({ preferFirst = true, preferredUid = "", cacheDir = join(homedir(), ".cache", "magpie"), configDir } = {}) {
  if (preferFirst) {
    const uid = String(preferredUid || readPreferredUid(PROVIDER, { configDir }).uid || "").trim()
    if (uid) {
      const mine = readInviteCache(inviteCacheFile(uid, cacheDir))
      if (mine) return { ...mine, kind: "preferred", uid }
    }
    return reservedInvite(cacheDir) ?? { code: "", url: "", kind: "none", uid: "" }
  }
  const accounts = readJson(inviteAccountsFile(cacheDir), {})
  const ordered = Object.entries(accounts && typeof accounts === "object" && !Array.isArray(accounts) ? accounts : {})
    .map(([uid, row]) => ({ uid, firstSeenAt: Number(row?.firstSeenAt) || 0, lastSeenAt: Number(row?.lastSeenAt) || 0 }))
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt || b.lastSeenAt - a.lastSeenAt || a.uid.localeCompare(b.uid))
  for (const entry of ordered) {
    const mine = readInviteCache(inviteCacheFile(entry.uid, cacheDir))
    if (mine) return { ...mine, kind: "latest", uid: entry.uid }
  }
  return reservedInvite(cacheDir) ?? { code: "", url: "", kind: "none", uid: "" }
}

/** rotate:false 是官方读取/首次生成路径；插件永远不自动 rotate:true。 */
export async function ensureInvite(auth, { fetchImpl = fetch, cacheDir = join(homedir(), ".cache", "magpie"), now = Date.now, force = false, freshMs = 6 * 3600_000 } = {}) {
  const jwt = accountJwt(auth)
  if (!jwt) throw fail("纯 API Key 不能生成邀请链接；请重新一次性导入", 401, CODES.signInRequired)
  const uid = String(auth?.metadata?.userId || auth?.uid || auth?.access || auth?.key || "account")
  noteCroliAccount(auth, { cacheDir, now })
  const file = inviteCacheFile(uid, cacheDir)
  const cached = readInviteCache(file)
  if (!force && cached && now() - cached.updatedAt < freshMs) return { ...cached, fromCache: true }

  try {
    const [codeResult, listResult] = await Promise.allSettled([
      requestJson(INVITE_CODE_URL, { method: "POST", key: jwt, body: { rotate: false }, fetchImpl }),
      requestJson(INVITE_LIST_URL, { key: jwt, fetchImpl }),
    ])
    if (codeResult.status === "rejected") throw codeResult.reason
    const data = codeResult.value
    const code = String(data.inviteCode ?? "").trim()
    const url = buildInviteUrl(code)
    const list = listResult.status === "fulfilled" ? listResult.value : {}
    const record = {
      code,
      url,
      inviterRewardCredits: Number(data.inviterRewardCredits ?? 0),
      inviteeRewardCredits: Number(data.inviteeRewardCredits ?? 0),
      completedCount: Number(list.completedCount ?? 0),
      totalRewardCredits: Number(list.totalRewardCredits ?? 0),
      updatedAt: now(),
    }
    writeJson(file, record)
    return { ...record, fromCache: false }
  } catch (error) {
    if (cached) return { ...cached, fromCache: true, warning: String(error?.message ?? error).slice(0, 200) }
    throw error
  }
}

/** 流式只在 flush 且出现终止标记后上报；非流式在 clone 中确认 choices，不消耗原响应。 */
export function trackConversation(response, onComplete) {
  if (!response || response.status !== 200 || typeof onComplete !== "function") return response
  const done = () => { void Promise.resolve().then(onComplete).catch(() => {}) }
  const type = String(response.headers.get("content-type") ?? "")
  if (response.body && /text\/event-stream/i.test(type)) {
    const decoder = new TextDecoder()
    let terminal = false
    const markTerminal = (text) => {
      if (text.includes("[DONE]") || /"finish_reason"\s*:\s*"[^"]+"/.test(text) || /"stop_reason"\s*:\s*"[^"]+"/.test(text) || /event:\s*message_stop/.test(text)) terminal = true
    }
    const stream = new TransformStream({
      transform(chunk, controller) {
        markTerminal(decoder.decode(chunk, { stream: true }))
        controller.enqueue(chunk)
      },
      flush() {
        markTerminal(decoder.decode())
        if (terminal) done()
      },
    })
    return new Response(response.body.pipeThrough(stream), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
  try {
    void response.clone().text().then((text) => {
      const data = JSON.parse(text)
      if (Array.isArray(data?.choices) && data.choices.length > 0) done()
    }).catch(() => {})
  } catch {}
  return response
}
