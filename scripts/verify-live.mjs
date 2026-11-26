// 真实四模型验证。只读 CROLI_GATEWAY_KEY，不读取 Croli auth.json，不启动客户端。
import { mkdir, writeFile } from "node:fs/promises"
import { CroliAuthPlugin } from "../index.mjs"
import { BASE, MODEL_SPECS } from "../src/croli.mjs"

const key = String(process.env.CROLI_GATEWAY_KEY || "").trim()
if (!key) {
  console.error("请通过环境变量 CROLI_GATEWAY_KEY 提供网关 Key；本脚本不会读取官方客户端登录态。")
  process.exit(2)
}

const plugin = await CroliAuthPlugin()
const auth = { type: "api", key }
const getAuth = async () => auth
const loaded = await plugin.auth.loader(getAuth)
if (typeof loaded.fetch !== "function") throw new Error("loader 没有返回 fetch")

const listed = await plugin.provider.models({}, { auth })
const listedIds = Object.keys(listed)
if (listedIds.length !== 4) throw new Error(`模型目录应为 4 项，实际 ${listedIds.join(", ")}`)

async function probe(spec) {
  const expected = `CROLI_DIRECT_${spec.id.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase()}`
  const body = {
    model: `croli/${spec.id}`,
    messages: [{ role: "user", content: `Reply with exactly ${expected} and nothing else.` }],
    max_tokens: 256,
    stream: true,
  }
  const response = await loaded.fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const error = await response.text()
    return { id: spec.id, ok: false, status: response.status, error: error.slice(0, 1000) }
  }
  const text = await response.text()
  let content = ""
  let upstreamModel = ""
  let usage
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue
    try {
      const chunk = JSON.parse(line.slice(5).trim())
      upstreamModel ||= chunk.model || ""
      usage = chunk.usage || usage
      for (const choice of chunk.choices || []) {
        const delta = choice.delta?.content ?? choice.message?.content
        if (typeof delta === "string") content += delta
      }
    } catch {}
  }
  return {
    id: spec.id,
    ok: response.status === 200 && content.includes(expected) && text.includes("[DONE]") && Boolean(usage),
    status: response.status,
    upstreamModel,
    content,
    hasDone: text.includes("[DONE]"),
    hasUsage: Boolean(usage),
    usage,
  }
}

const results = await Promise.all(MODEL_SPECS.map(probe))
const report = {
  verifiedAt: new Date().toISOString(),
  independentCredentialInput: "CROLI_GATEWAY_KEY only",
  officialAuthFileRequired: false,
  officialClientProcessRequired: false,
  listedIds,
  results,
}
await mkdir(new URL("../verification/", import.meta.url), { recursive: true })
await writeFile(new URL("../verification/live-results.json", import.meta.url), JSON.stringify(report, null, 2).replaceAll(key, "<redacted>"))
for (const result of results) console.log(JSON.stringify(result))
if (results.some((result) => !result.ok)) process.exit(1)
console.log("PASS: 四个模型均在纯 API Key、无客户端登录文件条件下完成流式调用。")
