// 真实账户验收：读取 magpie 已保存的 Croli 账号，只输出任务与公开邀请链接。
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { checkinToday, ensureInvite, fetchOpsHome } from "../src/croli-account.mjs"

const file = join(homedir(), ".config", "magpie", "plugin-auth.json")
const store = JSON.parse(await readFile(file, "utf8"))
const auth = store.croli
if (!auth?.metadata?.croliAccessToken) throw new Error("Croli 账号缺少一次性导入的账户凭证")

const [checkin, invite, home] = await Promise.all([
  checkinToday(auth),
  ensureInvite(auth),
  fetchOpsHome(auth),
])
const tasks = []
for (const program of home.programs ?? []) {
  for (const task of program.tasks ?? []) {
    tasks.push({
      id: task.id,
      key: task.key,
      status: task.status,
      progress: task.progress,
      target: task.target,
      periodUnit: task.periodUnit,
      periodKey: task.periodKey,
      rewards: (task.milestones ?? []).map((m) => ({ index: m.index, credits: m.credits, status: m.status })),
      streak: task.streak ?? undefined,
    })
  }
}
const report = {
  verifiedAt: new Date().toISOString(),
  checkin,
  invite: {
    url: invite.url,
    inviterRewardCredits: invite.inviterRewardCredits,
    inviteeRewardCredits: invite.inviteeRewardCredits,
    completedCount: invite.completedCount,
    totalRewardCredits: invite.totalRewardCredits,
    fromCache: invite.fromCache,
  },
  tasks,
  tokenIncluded: false,
}
await mkdir(new URL("../verification/", import.meta.url), { recursive: true })
await writeFile(new URL("../verification/account-features.json", import.meta.url), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
