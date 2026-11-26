// 已安装宿主验收：只调用本机 magpie，不读取或传递 Croli 凭据。
import { mkdir, writeFile } from "node:fs/promises"
import { MODEL_SPECS } from "../src/croli.mjs"

const origin = process.env.MAGPIE_URL || "http://127.0.0.1:3425"
const localHeaders = {
  "content-type": "application/json",
  ...(process.env.MAGPIE_API_KEY ? { authorization: `Bearer ${process.env.MAGPIE_API_KEY}` } : {}),
}
const response = await fetch(`${origin}/v1/models`, { headers: localHeaders })
if (!response.ok) throw new Error(`magpie /v1/models HTTP ${response.status}`)
const catalog = await response.json()
const rows = Array.isArray(catalog.data) ? catalog.data : []
const selected = MODEL_SPECS.map((spec) => {
  const candidates = rows.filter((row) => row?.id === `croli/${spec.id}` || row?.id === spec.id)
  return { spec, row: candidates[0] }
})
const missing = selected.filter((item) => !item.row).map((item) => item.spec.id)
if (missing.length) throw new Error(`magpie 宿主缺少模型：${missing.join(", ")}`)

async function probe({ spec, row }) {
  const expected = `MAGPIE_HOST_${spec.id.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase()}`
  const r = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: localHeaders,
    body: JSON.stringify({
      model: row.id,
      messages: [{ role: "user", content: `Reply with exactly ${expected} and nothing else.` }],
      max_tokens: 256,
      stream: true,
    }),
  })
  if (!r.ok) return { id: spec.id, hostModel: row.id, ok: false, status: r.status, error: (await r.text()).slice(0, 1000) }
  const text = await r.text()
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
    hostModel: row.id,
    ok: content.includes(expected) && text.includes("[DONE]") && Boolean(usage),
    status: r.status,
    upstreamModel,
    content,
    hasDone: text.includes("[DONE]"),
    hasUsage: Boolean(usage),
    usage,
  }
}

const results = []
for (const item of selected) results.push(await probe(item))
const report = { verifiedAt: new Date().toISOString(), origin, results }
await mkdir(new URL("../verification/", import.meta.url), { recursive: true })
await writeFile(new URL("../verification/magpie-host-results.json", import.meta.url), JSON.stringify(report, null, 2))
for (const result of results) console.log(JSON.stringify(result))
if (results.some((result) => !result.ok)) process.exit(1)
console.log("PASS: 四个模型均通过真实 magpie 宿主流式调用。")
