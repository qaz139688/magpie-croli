// Croli 四模型原生 API Key 直通插件。由 MYCF711/magpie-plugin-scaffold 生成。
// 九项钩子保留；运行时没有 Croli 进程、Agent 或客户端提示词依赖，账户 JWT 可独立续期。
import { usage as buildUsage, usageWindow } from "./src/quota.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"
import { createRefreshLock } from "./src/refresh-lock.mjs"
import { uidOf } from "./src/credential.mjs"
import { OFFICIAL_UA } from "./src/http.mjs"
import {
  refreshAccount,
  checkinToday,
  recordDailyConversation,
  ensureInvite,
  trackConversation,
  parseCroliInviteInput,
  writeReservedCroliInvite,
  resolveCroliInviteSource,
  readCroliInviteAccounts,
  readCroliInviteSelection,
  writeCroliInviteSelection,
} from "./src/croli-account.mjs"
import { readPreferredUid } from "./src/preferred.mjs"
import {
  PROVIDER,
  BASE,
  MODEL_SPECS,
  gatewayKeyOf,
  forwardRequest,
  importDesktopKey,
  fetchLiveModels,
  fetchCredits,
} from "./src/croli.mjs"

const PROVIDER_NAME = "Croli 免费模型 Croli Free Models"
const SDK = "@ai-sdk/openai-compatible"
const ICON = "data:image/png;base64,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"

/** 未登录和目录失败时的静态表。图片能力已于 2026-11-20 四模型逐一实测。 */
function staticModels() {
  const out = {}
  for (const spec of MODEL_SPECS) {
    out[spec.id] = {
      id: spec.id,
      name: spec.name,
      api: { id: spec.id, url: BASE, npm: SDK },
      status: "active",
      // 免费试用用完后会进入积分计费，不能标 free:true 让 Free first 反复派发。
      free: false,
      limit: { context: spec.context, output: spec.output },
      modalities: { input: ["text", "image"], output: ["text"] },
      capabilities: {
        temperature: true,
        reasoning: true,
        toolcall: true,
        attachment: true,
        input: { text: true, image: true, audio: false, video: false, pdf: false },
        output: { text: true },
      },
      variants: Object.fromEntries(spec.efforts.map((effort) => [effort, {}])),
    }
  }
  return out
}

export const CroliAuthPlugin = async (_ctx = {}, _options = {}) => {
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 60_000 })
  const refreshLock = createRefreshLock()
  const checkinLock = createRefreshLock({ replayMs: 0 })
  const option = (key, fallback) => {
    try {
      const value = _ctx?.magpie?.option?.(PROVIDER, key)
      return typeof value === "boolean" ? value : fallback
    } catch {
      return fallback
    }
  }

  let pendingInvite = null
  const cacheDir = () => _options.inviteCacheDir
  const configDir = () => _options.magpieConfigDir
  const accounts = () => readCroliInviteAccounts({ cacheDir: cacheDir(), configDir: configDir() })
  const preferredUid = () => readPreferredUid(PROVIDER, { configDir: configDir() }).uid
  const invitePrompt = () => ({
    type: "text",
    key: "invite",
    message: "手动邀请码（仅新注册账号有效）",
    placeholder: "留空 / 0 / 1 沿用手动预留码；也可填官方邀请链接或新邀请码",
    placement: "top",
  })
  const sourcePrompt = (rows, selected) => {
    const automatic = { value: "latest", label: "最新账号（自动滚动邀请）" }
    const manual = { value: "manual", label: "手动输入邀请码" }
    const options = [automatic, ...rows.map((row) => ({ value: row.uid, label: `${row.label}（${row.uid}）` })), manual]
    const remembered = String(selected ?? readCroliInviteSelection(cacheDir()) ?? preferredUid() ?? "latest").trim() || preferredUid() || "latest"
    const preferred = options.find((item) => item.value === remembered)
    return {
      type: "select",
      key: "inviteSource",
      message: "邀请来源（记住本次选择）",
      options: preferred ? [preferred, ...options.filter((item) => item !== preferred)] : options,
      placement: "top",
    }
  }
  const cachedInvite = () => {
    const preferred = option("invite_preferred", true)
    const saved = readCroliInviteSelection(cacheDir())
    return resolveCroliInviteSource({
      preferFirst: preferred && saved !== "latest",
      preferredUid: saved === "manual" ? "__manual__" : saved || preferredUid(),
      cacheDir: cacheDir(),
      configDir: configDir(),
    })
  }
  const captureInvite = async (inputs = {}) => {
    const preferred = option("invite_preferred", true)
    const rows = accounts()
    const selection = preferred
      ? String(inputs.inviteSource ?? readCroliInviteSelection(cacheDir()) ?? preferredUid() ?? "latest").trim() || preferredUid() || "latest"
      : "latest"
    if (selection === "manual" || rows.length === 0) {
      if (preferred && Object.prototype.hasOwnProperty.call(inputs, "inviteSource")) {
        writeCroliInviteSelection("manual", { cacheDir: cacheDir() })
      }
      const parsed = parseCroliInviteInput(inputs.invite)
      if (!parsed.ok) return { error: parsed.reason }
      if (!parsed.automatic) {
        const reserved = writeReservedCroliInvite(parsed.code, { cacheDir: cacheDir() })
        return { ...reserved, kind: "reserved", uid: "" }
      }
      return resolveCroliInviteSource({ preferFirst: true, preferredUid: "__manual__", cacheDir: cacheDir(), configDir: configDir() })
    }
    const account = selection === "latest" ? rows[0] : rows.find((row) => row.uid === selection)
    const chosen = account ?? rows[0]
    if (!chosen) return cachedInvite()
    if (preferred && Object.prototype.hasOwnProperty.call(inputs, "inviteSource")) {
      writeCroliInviteSelection(selection === "latest" ? "latest" : chosen.uid, { cacheDir: cacheDir() })
    }
    try {
      const own = await ensureInvite(chosen.auth, { cacheDir: cacheDir(), fetchImpl: _options.fetchImpl })
      return { ...own, kind: selection === "latest" ? "latest" : "preferred", uid: chosen.uid }
    } catch {
      return resolveCroliInviteSource({ preferFirst: true, preferredUid: chosen.uid, cacheDir: cacheDir(), configDir: configDir() })
    }
  }
  const importDesktopResult = async () => {
    try {
      const imported = await importDesktopKey()
      return {
        type: "success",
        access: imported.key,
        refresh: imported.refreshToken,
        expires: imported.expiresAt,
        accountId: "",
        uid: imported.uid,
        metadata: imported.metadata,
      }
    } catch (error) {
      return { type: "failed", error: String(error?.message ?? error) }
    }
  }

  return {
    // ① provider 与静态模型表
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        models: staticModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      icon: ICON,
      maxConcurrency: 4,
      refreshLead: 5 * 60_000,
      options: [
        {
          key: "stream-usage",
          label: "回传 Token 用量",
          description: "流式请求附加 include_usage；不改写消息、工具或系统提示词。",
          default: true,
        },
        {
          key: "auto-checkin",
          label: "自动签到与每日任务",
          description: "每天自动签到；真实对话完成后上报每日首聊，不伪造任务进度。",
          default: true,
        },
        {
          key: "invite_preferred",
          label: "首选账号作为邀请源",
          description: "关闭：自动使用最新注册账号滚动邀请；开启：登录时选择最新账号、指定账号或手动邀请码，并记住选择。",
          default: true,
        },
      ],

      methods: [
        {
          // 一次性导入：成功后保存的是独立网关 Key，之后不读取客户端。
          type: "oauth",
          label: "从本机 Croli 登录态导入 API Key",
          async authorize() {
            return {
              url: "https://www.croli.net/",
              instructions: "读取一次本机登录态并换取网关 Key；不会打开浏览器，之后可脱离客户端使用。",
              method: "auto",
              opened: true,
              callback: importDesktopResult,
            }
          },
        },
        {
          // 新账号注册：默认使用首选账号的邀请链接；已有账号请用一次性导入，不重复绑定。
          type: "oauth",
          label: "使用邀请链接注册并导入",
          get prompts() {
            const rows = accounts()
            if (rows.length === 0) return [invitePrompt()]
            return option("invite_preferred", true) ? [sourcePrompt(rows)] : []
          },
          async ask(inputs = {}) {
            const rows = accounts()
            const preferred = option("invite_preferred", true)
            if (preferred && rows.length > 0 && !Object.prototype.hasOwnProperty.call(inputs, "inviteSource")) {
              return sourcePrompt(rows)
            }
            const selection = preferred
              ? String(inputs.inviteSource ?? readCroliInviteSelection(cacheDir()) ?? preferredUid() ?? "latest").trim() || preferredUid() || "latest"
              : "latest"
            if ((selection === "manual" || rows.length === 0) && !Object.prototype.hasOwnProperty.call(inputs, "invite")) {
              return invitePrompt()
            }
            const selected = await captureInvite(inputs)
            if (selected.error) return { ...invitePrompt(), message: selected.error }
            pendingInvite = selected
            return null
          },
          async authorize() {
            const selected = pendingInvite ?? cachedInvite()
            const hasCode = Boolean(selected.code)
            return {
              url: hasCode ? selected.url : "https://www.croli.net/",
              instructions: hasCode
                ? "将打开默认邀请源链接。仅新注册账号有效；注册并登录桌面端后返回完成导入。"
                : "未找到可用邀请码，将打开官网。仅新注册账号有效；登录桌面端后返回完成导入。",
              method: "auto",
              opened: true,
              callback: importDesktopResult,
            }
          },
        },
        {
          // 原生体验：宿主原样保存 { type:"api", key }，无网络、无 authorize。
          type: "api",
          label: "Croli 网关 API Key",
          placeholder: "csk_...",
        },
      ],

      // ③ 聊天仍用网关 Key；账户 JWT 由 Clerk 公共客户端续期，同账号 single-flight。
      async refresh(auth) {
        if (!auth || auth.type === "api") return undefined
        return refreshLock.run(`${PROVIDER}\n${auth.refresh || uidOf(auth)}`, () => refreshAccount(auth))
      },

      // ④ OpenAI 兼容请求直通。Response/SSE 不读流，交给 magpie。
      async loader(getAuth) {
        const auth = await getAuth()
        const key = gatewayKeyOf(auth)
        if (!key) return {}
        return {
          baseURL: BASE,
          apiKey: key,
          headers: { "user-agent": OFFICIAL_UA },
          async fetch(input, init) {
            const fresh = await getAuth()
            const response = await forwardRequest(input, init, fresh, {
              includeUsage: option("stream-usage", true),
            })
            if (!option("auto-checkin", true) || !fresh?.metadata?.croliAccessToken) return response
            let model = ""
            try { model = String(JSON.parse(init?.body || "{}")?.model || "") } catch {}
            return trackConversation(response, async () => {
              try {
                const result = await recordDailyConversation(fresh, model)
                if (result.status === "claimed") usageCache.clear(String(uidOf(fresh)))
              } catch {
                // 任务上报失败不影响已经完成的模型响应。
              }
            })
          },
        }
      },

      // ⑤ 额度与邀请分独立读取：任一失败都不影响聊天，也不伪造额度。
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth || !gatewayKeyOf(auth)) return { error: "未登录", windows: [] }
        if (!auth.metadata?.croliAccessToken) {
          return { error: "API Key 模式不读取客户端额度与邀请；模型调用不受影响", windows: [] }
        }
        const usageKey = uidOf(auth)
        const [creditResult, inviteResult] = await Promise.allSettled([
          usageCache.readSWR(String(usageKey), () => fetchCredits(auth), { timeoutMs: 10_000 }),
          option("invite_preferred", true) ? ensureInvite(auth, { cacheDir: _options.inviteCacheDir }) : Promise.resolve(null),
        ])
        const windows = []
        if (creditResult.status === "fulfilled") {
          const value = creditResult.value
          const trial = value.trial
          if (trial && Number.isFinite(trial.used) && Number.isFinite(trial.dailyLimit) && trial.dailyLimit > 0) {
            windows.push(usageWindow({
              name: "今日免费额度",
              used: Math.round((trial.used / trial.dailyLimit) * 10000) / 100,
              amount: trial.used,
              limit: trial.dailyLimit,
              unit: "积分",
              resetsAt: trial.nextResetAt,
            }))
          }
          windows.push(usageWindow({ name: "积分余额", balance: value.balance, unit: "积分", display: `${value.balance} 积分` }))
        }
        if (inviteResult.status === "fulfilled" && inviteResult.value) {
          const invite = inviteResult.value
          windows.push(usageWindow({
            name: `邀请链接 · 已完成 ${invite.completedCount} 人`,
            used: 0,
            aside: true,
            display: invite.url,
          }))
        }
        if (creditResult.status === "fulfilled") {
          const value = creditResult.value
          return buildUsage({ plan: "Croli", balance: `${value.balance} 积分`, until: value.trial?.endsAt, windows })
        }
        const errors = [creditResult.reason?.message ?? creditResult.reason]
        if (inviteResult.status === "rejected") errors.push(inviteResult.reason?.message ?? inviteResult.reason)
        if (windows.length > 0) {
          return { plan: "Croli · 积分暂不可用", windows }
        }
        return {
          plan: "Croli",
          windows: [],
          error: `${errors.filter(Boolean).join(" · ")}；模型调用不受影响`,
        }
      },

      // ⑥ magpie 按北京时间每日调用；重复签到幂等，邀请链接随结果展示。
      async checkin(getAuth) {
        const auth = await getAuth()
        if (!auth?.metadata?.croliAccessToken) return { outcome: "ineligible", message: "纯 API Key 没有签到凭证，请重新一次性导入" }
        if (!option("auto-checkin", true)) return { outcome: "inactive", message: "自动签到已关闭" }
        const key = String(uidOf(auth))
        return checkinLock.run(`${PROVIDER}\n${key}`, async () => {
          try {
            const result = await checkinToday(auth)
            usageCache.clear(key)
            // 每日首聊任务只需账户凭证上报一次 agent_turn_completed 事件，服务端自动发放。
            // 上游给模型接口加了设备签名门槛后，真实对话可能拿不到，签到后顺手把当天任务结掉。
            try {
              const chat = await recordDailyConversation(auth, "croli-checkin", {})
              if (chat?.status === "claimed") {
                result.message = `${result.message} · 每日首次对话 +${chat.credit}`
              }
            } catch {
              // 任务上报失败不影响签到结果。
            }
            if (option("invite_preferred", true)) {
              try {
                const invite = await ensureInvite(auth, { cacheDir: _options.inviteCacheDir })
                result.message = `${result.message} · 邀请链接：${invite.url}`
              } catch {
                result.message = `${result.message} · 邀请链接读取失败`
              }
            }
            return result
          } catch (error) {
            return { outcome: "failed", message: String(error?.message ?? error).slice(0, 400) }
          }
        })
      },
    },

    // ⑦ 每账号目录只保留四个已验证模型；目录失败回退静态表，401 才标记 Key 失效。
    provider: {
      id: PROVIDER,
      async models(_provider, { auth } = {}) {
        const fallback = staticModels()
        if (!gatewayKeyOf(auth)) return fallback
        try {
          const live = await fetchLiveModels(auth)
          const out = {}
          for (const model of live) out[model.id] = { ...fallback[model.id], ...model }
          return out
        } catch (error) {
          if (error?.status === 401) throw Object.assign(new Error("Croli 网关 API Key 已失效，请重新导入或更换"), { signIn: "expired" })
          return fallback
        }
      },
    },

    // ⑧ 故意不加会话头、客户端标识头或提示词字段。
    "chat.headers": async () => {},
  }
}

export const _internal = {
  PROVIDER,
  BASE,
  MODELS: MODEL_SPECS,
  staticModels,
}
