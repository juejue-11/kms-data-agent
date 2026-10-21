# PCB-agent —— PCB 缺陷分析助手

面向 PCB 生产制造的企业级 AI 助手。第一版实现**对话 + 缺陷定位**：用户描述异常现象，AI 从知识库检索并定位缺陷类型（标准名称），标注出处；知识库未命中时自动联网搜索兜底（网络结果单独标注）。

## 架构

```
本地（agent）                        服务器
┌────────────────────────┐          ┌─────────────────────────┐
│ agent (node server.js) │  HTTP    │ RAGFlow                  │
│  └─ rag/retrieve.js ───┼─────────>│  └─ Ollama embedding      │
│     (接口隔离，可换)     │          │  知识库（资料库 + 缺陷说明）│
└────────────────────────┘          └─────────────────────────┘
   浏览器 http://localhost:9100
```

- **agent**：本仓库（Pi 框架 fork + 前端 + RAG 检索代码）
- **RAGFlow**：开源 RAG 引擎（Apache 2.0），单独部署在服务器上，做语义检索
- **Ollama**：本地 embedding 模型服务
- **接口隔离**：`rag/retrieve.js` 的 `searchKnowledgeBase()` 是唯一接口，以后想换 RAG 后端（Milvus/Qdrant/自研）只改这一个函数

## 目录结构（本仓库）

```
agent/
├── server.js           # Express 后端：检索 → 拼 prompt → agent 生成 → 附出处
├── rag/retrieve.js     # RAG 检索抽象层（知识库检索 + 联网搜索）
├── web-ui/             # 前端聊天界面
│   ├── index.html      # 页面骨架
│   ├── css/style.css   # 主题与 Markdown 排版
│   ├── js/script.js    # 对话交互
│   ├── js/markdown.js  # Markdown 渲染（token → DOM）
│   └── vendor/         # 浏览器端第三方库（marked）
├── packages/...        # Pi 框架（fork 自 earendil-works/pi，MIT）
├── .env.example        # 配置模板（复制成 .env 后填写）
└── README.md           # 本文件
```

> 说明：甲方资料（`.doc`/`.xlsx`）和解析后的数据**不在本仓库**（涉密，不公开）；RAGFlow 引擎源码也不在本仓库（单独部署在服务器）。

## 工作原理（缺陷定位）

```
用户输入异常描述
   ↓
① 知识库检索  searchKnowledgeBase()
   ├─ 命中（RAGFlow 语义检索）→ 相似度≥0.35 过滤后取 top2 + 出处
   └─ 未命中 → ② 联网搜索 webSearch()（标注「网络来源」）
   ↓
③ 组装 prompt（角色 + 参考资料 + 出处 + 用户问题）
   ↓
④ Pi agent 生成回答
   ↓
⑤ 返回 { reply, sources }，前端展示回答 + 出处标注
```

「同一个意思不同说法」的识别靠 RAGFlow 的向量语义相似度（embedding）。检索时先按相似度阈值（0.35）过滤无关片段，再取 top2，避免无关资料混入。

## 快速开始

### 1. 安装依赖并构建（只需一次）

```bash
npm install --ignore-scripts
npm run build
```

### 2. 配置环境变量

```bash
cp .env.example .env    # 然后编辑 .env，填 RAGFlow 地址 / API Key / dataset id
```

### 3. 部署 RAGFlow（需要 Docker，建议 Linux 服务器）

RAGFlow 官方推荐 Linux 服务器（≥4 核 / ≥16GB 内存）。部署后建知识库、上传资料，生成 API Key 和 dataset id，填回 `.env`。

> 不部署 RAGFlow 也能跑通对话链路（走本地文本匹配 + 联网搜索），只是检索效果不如向量语义检索。

### 4. 启动

```bash
node --env-file=.env server.js
# 浏览器打开 http://localhost:9100
```

## 环境变量（.env）

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 后端端口 | 9100 |
| `RAGFLOW_BASE_URL` | RAGFlow API 地址 | http://localhost:80 |
| `RAGFLOW_API_KEY` | RAGFlow API Key | 空 |
| `RAGFLOW_DATASET_IDS` | 知识库 dataset id，逗号分隔；留空走本地匹配 | 空 |
| `SEARCH_PROVIDER` | 联网搜索：`tavily` / `duckduckgo` | duckduckgo |
| `TAVILY_API_KEY` | Tavily Key（推荐，搜索质量更好） | 空 |

## 已知问题

- `packages/ai/src/providers/opencode-go.ts` 曾因上游模型目录漂移导致编译失败，已手动补了 `google-generative-ai` 类型。若以后 `git pull` 更新 Pi 后构建报这个错，检查该文件是否被覆盖。
- 本地文本匹配兜底（`searchLocal`）是关键词匹配，语义能力弱，仅用于无 RAGFlow 时的临时兜底。

## License

本项目基于 [Pi](https://github.com/earendil-works/pi)（MIT）构建。
