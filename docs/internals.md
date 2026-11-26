# Croli 插件实现与验证

## 架构

```text
DSH / 其他 OpenAI 客户端
  → magpie
  → CroliAuthPlugin
  → https://ds.croli.net/v1
  → Croli 上游路由
```

插件由 `MYCF711/magpie-plugin-scaffold` 的 `create.mjs` 生成，保留九项钩子、通用模块、检查器与测试结构。

- `index.mjs`：只负责装配 config/auth/models/usage/checkin/chat.headers。
- `src/croli.mjs`：网关目录、一次性导入、额度读取和请求转发。
- `src/croli-account.mjs`：Clerk 续期、每日任务、真实对话完成上报与邀请缓存。
- `scripts/verify-live.mjs`：只接受环境变量中的 Key，独立验证各模型的流式请求。
- `scripts/verify-account.mjs`：真实签到状态、每日任务和公开邀请链接验收。

## 凭证边界

### 纯 API Key

宿主直接保存 `{ type: "api", key }`。这是推荐路径：没有 `authorize()`、没有网络、没有 OAuth 刷新。

### 一次性导入

`auth.methods[0]` 使用脚手架的本机客户端导入形态：

1. `authorize()` 立即返回 `opened: true`，不等待网络。
2. `callback()` 读取一次 Croli `auth.json` 的 Clerk access token。
3. 用 `GET https://api.croli.net/relay/api/relay/search` 换取覆盖核心模型的 `sk`（判据见 `CORE_MODEL_IDS`）。
4. 宿主保存 `{ type: "oauth", access: <sk>, refresh: <Clerk refresh token>, expires: <ms> }`。
5. 聊天只使用 `sk`；账户 JWT 用于积分、签到、每日任务和邀请。

`refresh()` 通过 `https://clerk.croli.net/oauth/token` 的公共客户端表单续期，只发送 `grant_type`、`client_id`、`refresh_token` 三项。新 refresh token 非空就替换，否则保留旧值；同账号 single-flight。遇到 `invalid_grant` 时，仅在本机登录文件提供了不同 token 的情况下重试一次，用于兼容官方客户端已经轮换 token 的场景。网络错误不会误删账号。

纯 API Key 不进入刷新链，聊天始终不依赖官方客户端进程。网关目录没有返回 `sk` 的 TTL；Key 被吊销或轮换时，重新导入即可。

## 提示词与请求原样性

`forwardRequest()` 只做这些事情：

- 设置网关 Bearer Key 和完整 Chrome User-Agent。
- 把 `croli/<model>` 还原成上游 `<model>`。
- 流式请求默认补 `stream_options.include_usage: true`。
- 校验目标 URL，拒绝把 Key 发往非 Croli 地址。

它**不会做**这些事情：

- 不添加 system/developer/instructions/prompt。
- 不删除调用方的 system prompt。
- 不改 messages、tools、tool schema、additionalProperties。
- 不启动 DeepSeek ACP、Croli Agent 或任何子进程。
- `forwardRequest()` 不读取流式响应体；只有开启每日任务时，外层才附加终止标记检测并逐块透明转发。

`tests/croli.test.mjs` 用捕获的上游请求逐项锁定这些边界。

开启自动签到后，`trackConversation()` 只在两种情况下上报任务：非流式在 clone 中确认 choices，或 SSE 字节流完整 flush 且出现 `[DONE]` / `finish_reason` / `stop_reason` / `message_stop`。截断流不算完成。SSE 包装只逐块透传，不修改内容、不缓冲整段内容；关闭开关或纯 API Key 时返回原 Response。

## 每日任务与邀请

- `GET /credits/v1/ops/home` 读取 `daily-checkin`、`daily-first-chat` 和一次性任务。
- `POST /credits/v1/ops/checkin` 只带真实 `taskId`，按 `alreadyCheckedIn / creditsAwarded / streak` 映射结果。
- `POST /credits/v1/ops/events` 使用账号指纹与周期组成幂等 eventId，metadata 只有 `source` 和 `model`，没有 token。
- `POST /credits/v1/invite/code` 固定 `{rotate:false}`；官方稳定分享地址为 `https://www.croli.net/invite/?code=<code>`。
- 邀请缓存位于 `~/.cache/magpie/croli-invite-<账号指纹>.json`，只保存 code、URL、奖励与完成统计。账号索引只保存稳定 uid 的散列文件名与首次/最近见到时间，不保存显示名或 token。
- 默认 `invite_preferred=true`：`inviteSource` 下拉把 Magpie 首选 uid 排在第一项，也可选 `latest`、其他稳定 uid 或 `manual`。选择写入独立 `croli-invite-source.json`，不保存 token；关闭开关时直接使用最新账号。
- 「使用邀请链接注册并导入」在 `ask()` 中按所选 uid 调 `ensureInvite()` 取该账号自己的码并记住选择，`authorize(undefined)` 复用同一快照，零出站。手动分支才显示邀请码输入，预留码与账号选择分文件保存。邀请关系只在用户于官方页面新注册时建立，已有账号不调用绑定端点。

「首选账号作为邀请源」与签到、Token 用量都显示完整说明，暂位于模型下方，三个开关在调用点实时读取。关闭邀请后自动使用最近账号，关闭签到后不执行签到或任务事件上报。Magpie 当前 `.plugin-options.top` 会撞上页头 `.top { height:46px }`，完整多行置顶需等待上游 #7353 修复。

## 模型元数据

| 模型 | 实际上游标识 | 上下文 | 输出 |
|---|---|---:|---:|
| `DeepSeek-V4.1-Flash` | `deepseek/deepseek-v4.1-flash-1017` | 1,048,576 | 384,000 |
| `gpt-6-luna` | `gpt-6-luna` | 1,050,000 | 128,000 |
| `claude-opus-5.5` | `group/auto-claude-opus-5-5`，响应头另标 OpenRouter Claude Opus 5.5 | 1,000,000 | 128,000 |
| `grok-4.6` | `x-ai/grok-4.6` | 500,000 | 450,000 |

上下文与输出上限来自上游实时目录和官方文档，不是脚手架占位值。已实测的模型都识别了测试图中的 `MAGPIE`，因此显式声明 `capabilities.input.image: true`；新增的四项（`gpt-6.1-sol` / `gpt-5.6-sol` / `gpt-5.6-luna` / `claude-sonnet-5`）只实测了文本，窗口字段见上表注释。

## 错误分类

- 纯网关 401：Key 失效，允许重新导入。
- 模型 400 且明确模型不可用：改 404，只搁置模型。
- 网络错误：503；超时：504。
- 额度 JWT 失效：只影响额度卡片，不把网关 Key 标记失效。
- 400/422 的余额、渠道、模型、限流错误使用脚手架 `rewriteRefusal()`；其他响应和 SSE 原样返回。

## 验证

```bash
npm test
node scripts/check.mjs
npm pack --dry-run
```

真实验证只给插件 `CROLI_GATEWAY_KEY`，同时把 `CROLI_AUTH_FILE` 指向不存在的路径：

```bash
CROLI_GATEWAY_KEY=<GATEWAY_KEY> CROLI_AUTH_FILE=<MISSING_FILE> node scripts/verify-live.mjs
```

验证结果保存在 `verification/live-results.json`（本机证据，不进仓库）：

- 各模型目录全部存在。
- 各模型流式请求均为 HTTP 200。
- 各答案都包含各自随机标识。
- 各响应都有 `[DONE]` 和 usage。
- 各实际上游模型标识与逆向结果一致。

图片证据见上级分析目录 `analysis/vision-probes.json`。

真实 Magpie 宿主复验使用 `node scripts/verify-host.mjs`，结果在 `verification/magpie-host-results.json`。`0.1.0` 初次装配时四个宿主流式请求全部成功；`0.1.1` 当前回归中 DeepSeek 恢复 200，GPT/Claude/Grok 分别遇到 OpenCode Go 的 5 小时额度 429，属于上游账户额度状态，不是插件装配失败。

新版登录记录为 `access=csk_...`、`hasRefresh=true`、`expires=<TIMESTAMP>`。今日签到与每日首聊均为 `claimed`，奖励正常入账；邀请 URL 作为独立 `aside` 窗口展示。积分接口偶发 429 时只影响额度读数，邀请窗口仍保留，聊天继续。

Clerk 刷新协议由 OIDC 配置、二进制证据和 mock 测试共同验证；没有为了测试而主动轮换当前真实 refresh token，避免与仍在使用官方客户端的会话发生不必要的竞争。

## 回滚

卸载插件不会修改 Croli 客户端：

```bash
magpie plugin logout croli
magpie plugin rm magpie-croli
```

如需撤销 API Key，在 Croli 侧重新生成/轮换网关 Key；本地删除账号只删除保存的副本。
