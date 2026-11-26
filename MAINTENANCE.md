# MAINTENANCE.md —— 维护台账

> 接手前先读本页，再按 AGENTS.md 定位对应专档。每次交付后更新状态与下一步。

## 一、身份

| 项 | 值 |
|---|---|
| 插件 | `magpie-croli` |
| 显示名 | `Croli 免费模型 Croli Free Models` |
| provider | `croli` |
| 当前版本 | `0.1.5`（GitHub 源码与 Release，未发 npm） |
| 上游脚手架 | `MYCF711/magpie-plugin-scaffold` v0.3.14 / `d4c7a5014f64f3582b92a9a3e543949b57c6e96c` |
| 定位 | 四模型原生 API Key 直通，脱离 Croli 客户端，零客户端提示词注入 |

## 二、当前状态（2026-11-20）

```text
分支        main（GitHub MYCF711/magpie-croli 首发）
版本        0.1.5
发布状态    GitHub 源码与 Release；无 npm
```

| 资产 | 数量 |
|---|---:|
| `src/` 模块 | 33 个 |
| `tests/` | 34 个 / 427 条 |
| 对外模型 | 4 个 |
| 图片实测 | 4 / 4 通过 |
| 独立流式实测 | 4 / 4 通过 |

已验证：

- `node scripts/check.mjs`：45 通过 / 0 警告 / 0 失败；
- `node --test`：427 通过 / 0 失败；
- `node scripts/check-ua.mjs .` 与 `check-error-codes.mjs`：0 失败；
- `node scripts/privacy-scan.mjs`：PASS；
- `npm pack --dry-run`：116 个文件，含 README、CHANGELOG、docs、测试与 Croli 适配层；
- `scripts/verify-live.mjs`：只给网关 Key、登录文件路径不存在时，四模型仍全部完成流式调用；
- `scripts/verify-host.mjs`：真实 Magpie 宿主目录精确四项，四个宿主流式请求全部通过；
- 账户验证：今日签到已领取 100 积分；邀请码稳定复用，邀请人 2500 / 被邀请人 3000；
- `scripts/verify-account.mjs`：任务、签到和邀请链接真实通过，证据不含 token；
- 图片探针：四模型均正确读出 `MAGPIE`。

## 三、下一步

- 独立审查发现的“部分模型 Key 也可导入”major 已修复并回归验证。
- `0.1.1` 独立审查已放行，宿主已重载；`hasRefresh=true`、到期时间已落盘，今日签到/首聊均领取，邀请窗口真实可见。
- `0.1.2` 修复 `.plugin-options.top` 与页头 `.top` 的 46px 限高冲突：仅邀请紧凑置顶，其余两项下移；当前二进制资源几何测试由重叠 114.9px 变为间距 30px。
- `0.1.3` 默认使用 magpie 首选账号作为邀请源，真实本机默认链接与注册授权链接一致；真实邀请码只在本机缓存，不进 Git。
- `0.1.5` 对照百智云 `invite-policy` 改为 `inviteSource` 下拉：默认首选、指定账号、最新账号或手动码，记住选择；`ask()` 按 uid 取码，`authorize()` 零出站，真实本机默认链接不变。
- 官方 Magpie `.plugin-options.top` 的 46px 冲突已提交 `yetone/magpie#7353`，完整说明暂放模型下方，待上游修复后恢复多项完整置顶。

## 四、硬约束

- 不启动、关闭或重启 Croli / magpie 作为实现手段。
- 不把 magpie 全局 `proxy` 指向本机临时端口。
- 不把真实 Key、JWT、用户账号或本机路径写进仓库。
- 不添加、删除或改写调用方 system、messages、tools 与 schema。
- 不将消耗积分的模型误标为永久免费。
- 代码交付必须重新跑完整检查、测试、脱敏和 pack；真实行为改动还要重跑四模型 live。

## 五、给接手者的最短路径

1. 读 `README.md` 与 `docs/internals.md`；
2. 读 `index.mjs`、`src/croli.mjs` 和对应测试；
3. `git status` 核实未提交改动；
4. 修改后跑完整交付门并更新本文件。
