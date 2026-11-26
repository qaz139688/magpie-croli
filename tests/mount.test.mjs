// Croli 入口与九钩子装配契约。
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import * as entry from "../index.mjs"

const { CroliAuthPlugin, _internal } = entry
const EXPECTED = [
  "DeepSeek-V4.1-Flash",
  "gpt-6-luna",
  "gpt-6.1-sol",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "claude-opus-5.5",
  "claude-sonnet-5",
  "grok-4.6",
]

test("入口只导出一个插件工厂", () => {
  assert.deepEqual(Object.entries(entry).filter(([, value]) => typeof value === "function").map(([key]) => key), ["CroliAuthPlugin"])
  assert.equal(typeof _internal, "object")
})

test("九项钩子、三种登录与数据字段齐全", async () => {
  const plugin = await CroliAuthPlugin({ client: {} })
  assert.equal(typeof plugin.config, "function")
  assert.equal(plugin.auth.provider, "croli")
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, "croli")
  assert.ok(plugin.auth.icon.startsWith("data:image/"))
  assert.ok(plugin.auth.maxConcurrency >= 1)
  assert.equal(plugin.auth.methods.length, 3)
  assert.equal(plugin.auth.methods[0].type, "oauth")
  assert.equal(plugin.auth.methods[0].authorize.constructor.name, "AsyncFunction")
  assert.equal(plugin.auth.methods[1].type, "oauth")
  assert.equal(plugin.auth.methods[1].authorize.constructor.name, "AsyncFunction")
  assert.equal(plugin.auth.methods[2].type, "api")
  assert.equal(plugin.auth.methods[2].authorize, undefined, "API Key 应由宿主原样保存")
})

test("config 声明完整模型表，窗口和实测图片能力完整", async () => {
  const plugin = await CroliAuthPlugin()
  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider.croli.models
  assert.deepEqual(Object.keys(models), EXPECTED)
  for (const [id, model] of Object.entries(models)) {
    assert.equal(model.id, id)
    assert.equal(model.api.url, _internal.BASE)
    assert.equal(model.api.npm, "@ai-sdk/openai-compatible")
    assert.notEqual(model.free, true)
    assert.ok(model.limit.context >= 500_000)
    assert.ok(model.limit.output >= 128_000)
    assert.deepEqual(model.modalities.input, ["text", "image"])
    assert.deepEqual(model.modalities.output, ["text"])
    assert.equal(model.capabilities.attachment, true)
    assert.equal(model.capabilities.toolcall, true)
    assert.equal(model.capabilities.reasoning, true)
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean")
    }
    assert.equal(model.capabilities.input.image, true)
  }
})

test("一次性导入的 authorize 立即返回且不打开浏览器", async () => {
  const plugin = await CroliAuthPlugin()
  const flow = await plugin.auth.methods[0].authorize()
  assert.equal(flow.opened, true)
  assert.equal(flow.method, "auto")
  assert.equal(typeof flow.callback, "function")
})

test("loader 同时接受原生 API Key 与一次性导入的 oauth Key", async () => {
  const plugin = await CroliAuthPlugin()
  for (const auth of [{ type: "api", key: "csk_test" }, { type: "oauth", access: "csk_test" }]) {
    const loaded = await plugin.auth.loader(async () => auth)
    assert.equal(loaded.baseURL, _internal.BASE)
    assert.equal(loaded.apiKey, "csk_test")
    assert.equal(typeof loaded.fetch, "function")
  }
  assert.deepEqual(await plugin.auth.loader(async () => null), {})
})

test("未登录与纯 API Key 的 usage 都不伪造额度", async () => {
  const plugin = await CroliAuthPlugin()
  assert.deepEqual(await plugin.auth.usage(async () => null), { error: "未登录", windows: [] })
  const direct = await plugin.auth.usage(async () => ({ type: "api", key: "csk_direct" }))
  assert.match(direct.error, /不读取客户端额度/)
  assert.deepEqual(direct.windows, [])
})

test("未登录模型目录回退静态表，签到没有写操作", async () => {
  const plugin = await CroliAuthPlugin()
  const models = await plugin.provider.models({}, { auth: null })
  assert.deepEqual(Object.keys(models), EXPECTED)
  assert.deepEqual(await plugin.auth.checkin(async () => null), { outcome: "ineligible", message: "纯 API Key 没有签到凭证，请重新一次性导入" })
  assert.equal(await plugin.auth.refresh(), undefined)
})

test("chat.headers 不添加任何客户端头；选项在使用点读取", async () => {
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  const plugin = await CroliAuthPlugin()
  const output = { headers: { existing: "kept" } }
  await plugin["chat.headers"]({ model: { providerID: "croli" }, sessionID: "secret-session" }, output)
  assert.deepEqual(output, { headers: { existing: "kept" } })
  assert.deepEqual(plugin.auth.options.map((item) => item.key), ["stream-usage", "auto-checkin", "invite_preferred"])
  for (const item of plugin.auth.options) assert.equal(item.default, true)
  assert.deepEqual(plugin.auth.options.map((item) => item.placement), [undefined, undefined, undefined])
  assert.match(plugin.auth.options.find((item) => item.key === "invite_preferred")?.description, /指定账号或手动邀请码/)
  assert.match(source, /_ctx\?\.magpie\?\.option\?\.\(PROVIDER, key\)/)
  assert.match(source, /option\("stream-usage", true\)/)
})

test("运行时代码不启动官方客户端或 Agent", () => {
  const source = readFileSync(new URL("../index.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(source, /Croli\.exe|croli-server|child_process|spawn\(|exec\(/i)
})
