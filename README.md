# PCB Agent

基于仓库内 Pi 源码的 PCB 质量与工艺分析助手。Pi 负责模型、对话历史、活动分支、工具、压缩和重试；应用层负责访客归属、检索策略、请求生命周期和证据展示。网页和 CLI 连接同一 HTTP 服务。

需求对应、验证结果和现场验收边界见 [Pi 复用实施与验收记录](PI_REUSE_IMPLEMENTATION.md)。

## 启动

开发验证版本为 Node.js 24.14.1。需要原生 TypeScript 与同步解析钩子，依赖、生成模型数据与平台原生组件须匹配当前仓库版本。

```powershell
npm ci --ignore-scripts
Copy-Item .env.example .env
npm run start:pcb
# 另一个终端
npm run cli:pcb
```

浏览器访问 `http://127.0.0.1:9100`，也可用 `./start.ps1`。Ctrl+C 会取消并等待活动请求、释放实例和数据目录锁。原 `stop.ps1` 强制终止进程；异常退出后的未确认请求恢复为 interrupted。

手动入口必须预加载源码解析器，服务启动会断言工作区包解析到 src，禁止回落旧 dist：

```powershell
node --import ./packages/coding-agent/src/experimental/source-resolver.ts --env-file-if-exists=.env server.js
node --import ./packages/coding-agent/src/experimental/source-resolver.ts --env-file-if-exists=.env cli.js
```

## 配置与数据

业务配置见 [.env.example](.env.example)。相对路径相对仓库根目录；工作目录默认位于专用数据目录，不加载开发 AGENTS、个人 skills 或无关扩展。只托管 `web-ui/`。

模型、思考级别、compaction 与 retry 统一使用 `.pi-agent/settings.json`，认证使用 `.pi-agent/auth.json`，自定义模型使用 `.pi-agent/models.json`，格式沿用 [Pi 设置](packages/coding-agent/docs/settings.md) 与 [模型配置](packages/coding-agent/docs/models.md)。网页和 CLI 不单独接收模型凭据。

Pi JSONL 保存在 `.pcb-data/owners/<opaque-owner>/sessions/<sessionId>/pi/`。metadata 保存归属、标题和状态，requests 保存正文哈希、状态和条目关联，不另存完整聊天正文。首次用户消息前 Pi 文件可以不存在；实例闲置回收后历史保留。缺失或损坏的非空历史会明确报错。

同一数据目录只允许一个服务进程，`service.lock` 防止多个写入者。遗留锁仅在确认原进程已退出时处理，损坏锁须人工检查。备份时同时保留 JSONL、索引和 identity-secret。访客由服务端签发的 HttpOnly、SameSite Cookie 隔离，签名密钥跨重启稳定。CLI 保存服务端 Cookie，不允许自报其他用户身份。凭据丢失后仅凭旧会话 ID 不能恢复权限。公网部署应通过 HTTPS 反向代理和已验证账号身份接入；当前实现为独立访客模式。

## 工具与证据

默认只注册 `search_knowledge_base`、`search_web`、`get_evidence`，没有编码工具。Pi 结合完整会话生成检索词，工具结果由 Pi 保存。知识库正常无结果才可联网；故障后联网需额外打开 `PCB_ALLOW_WEB_ON_KB_ERROR`。外网与本地降级默认关闭。本地关键词匹配明确标为 local/degraded，不称为语义检索。指定 Tavily 却无密钥时明确报配置错误。

工具按模型输出顺序串行执行，执行处校验知识库前置条件；本轮已有内部证据后，后续空结果不能绕过限制。每次尝试占用调用预算，超额或超时由监督器取消，不在工具回调内等待自身结束。

PCB 压缩扩展直接调用 Pi 原生 compact，传入 `resources/pcb/compaction.md`，复用 preparation、split-turn、摘要重试与历史持久化。Pi 扩展处理器会捕获异常，因此摘要失败时显式取消压缩，报告中断并保留原始历史，禁止再回落执行通用摘要。没有修改 Pi 核心，没有第二套摘要或消息存储。

## HTTP 与客户端

| 方法和路径 | 行为 |
|---|---|
| POST /api/sessions | 新建本人会话 |
| GET /api/sessions | 分页列出本人会话 |
| GET /api/sessions/:id | 标题、状态和 activeRequestId |
| PATCH /api/sessions/:id | 提交 `{title}` 重命名，去除首尾空白后为 1～100 个字符 |
| DELETE /api/sessions/:id | 停止并等待活动请求，删除元数据、请求记录和 Pi 消息历史 |
| GET /api/sessions/:id/messages?before=&limit= | 从 Pi 活动分支投影历史 |
| POST /api/sessions/:id/messages | 提交 `{requestId,message}`，Accept 为 JSON 或 text/event-stream |
| GET /api/sessions/:id/requests/:requestId | 查询运行和终态 |
| POST /api/sessions/:id/requests/:requestId/cancel | 幂等停止指定请求 |

创建和查询均返回 `title`。空会话显示“新会话”，首次受理提问时取第一句话的前 20 个字符，超长加“…”；手动名称优先保留并持久化。网页列表提供重命名和删除操作，删除须在锁定背景的模态框中确认，点击遮罩不会关闭；删除当前会话后切换到其他会话，列表为空时显示新会话页。

requestId 为客户端 UUID。同 ID 同内容不再执行模型，运行中返回 202 JSON，终态返回既有结果；同 ID 不同内容返回 409。新请求遇到运行会话返回 SESSION_BUSY，服务并发上限返回 SERVICE_BUSY。客户端检查实际 Content-Type，断流后查询，不自动重发。

事件格式为 `{sessionId,requestId,sequence,type,payload}`。增量仅临时展示，最终消息覆盖增量；等待 prompt 与 waitForIdle 并检查 stopReason，不能以 agent_end 当作业务成功。断流默认继续执行；显式停止、超时或退出才取消。慢客户端缓冲有上限，关闭流后仍可查询终态。

## 记忆与验证

`PCB_MEMORY_ENABLED=true` 才注册业务记忆工具。记忆单独保存，按 owner、适用范围、有效时间和确认状态过滤，保留来源会话与条目。用户可查看、更正、删除；旧版本不再作为当前事实检索，不自动把所有聊天变成事实。删除记忆不改写原始会话。

```powershell
npm run check:pcb
npm run test:pcb
npm run eval:pcb
npm run check
```

自动测试不读取真实 .env、不调用线上 RAGFlow 或计费模型。集成测试复用 Pi faux provider，经过真实会话与 HTTP 适配。`test/evals/` 与 `test/fixtures/` 分别维护评分器与脱敏标注，区分检索和最终判定、判据、候选及追问。离线样例通过率不代表真实模型准确率；须测量真实业务基线后再制定发布门槛。

## 模块职责

`app/agent` 编排请求，`app/sessions` 管理归属及实例，`app/runtime` 集中接入 Pi，`app/tools` 注册业务扩展，`rag` 仅适配检索，`app/evidence` 投影引用，`app/http` 提供身份和传输，`app/cli` 为 HTTP 客户端，`app/memory` 保存可选事实。Pi 核心不反向导入应用层。PCB 提示位于 `resources/pcb/`，业务测试位于 `test/`。

本项目基于 [Pi](https://github.com/earendil-works/pi)（MIT）。客户原始资料和真实会话不提交。
