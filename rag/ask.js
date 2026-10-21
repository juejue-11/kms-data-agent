// PCB 缺陷分析核心：知识库检索 + 联网兜底 + Pi agent 作答
// server.js（HTTP 接口）与 cli.js（终端交互）共用此模块。

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { searchKnowledgeBase, webSearch } from "./retrieve.js";

// PCB 缺陷分析专家的人设（追加到 Pi 默认系统提示之后）
const EXPERT_PROMPT = `
## 角色：PCB 缺陷分析专家
你是一名资深的印制电路板（PCB）质量工程师，负责依据甲方技术资料，准确判定用户所描述缺陷的标准名称，并给出判定依据。

回答要求：
- 行文正式、严谨、专业，使用规范的质量工程术语，结论清晰、有据可依。
- 严格基于下方「参考资料」作答，不得臆造资料中不存在的内容。
- 每一项结论均须标注出处：知识库资料标注；联网检索内容标注。
- 当知识库缺乏相关资料时，基于通用专业知识补充。
- 若用户描述不足以唯一判定缺陷类型，应列出可能的候选类型及各自判据，不得武断定论。
- 不要调用工具、不要写代码。
`;

// 组装检索到的资料 + 用户问题 → 交给 agent 的 prompt
function buildPrompt(question, kbHits, webHits) {
  const blocks = [];
  if (kbHits.length) {
    blocks.push(
      "## 参考资料（知识库）\n" +
        kbHits.map((h, i) => `[${i + 1}] ${h.text}\n（来源：${h.source}）`).join("\n\n"),
    );
  }
  if (webHits.length) {
    blocks.push(
      "## 参考资料（联网搜索）\n" +
        webHits
          .map((h, i) => `[${i + 1}] ${h.text}\n（来源：${h.url || h.title || "网络"}）`)
          .join("\n\n"),
    );
  }
  const ctx = blocks.length ? blocks.join("\n\n") : "（知识库中暂无相关资料）";
  return `${ctx}\n\n## 用户问题\n${question}`;
}

/**
 * 检索并作答。
 * @param {string} question 用户问题
 * @param {(delta: string) => void} [onDelta] 流式回调，收到增量文本时触发（用于 CLI 实时打印）
 * @returns {Promise<{reply: string, sources: Array<{text: string, source: string, type: string}>, usedWeb: boolean}>}
 */
export async function askPCB(question, onDelta = () => {}) {
  // 1) 知识库检索
  let kbHits = [];
  try {
    kbHits = await searchKnowledgeBase(question);
  } catch (err) {
    console.warn("[ask] 知识库检索失败:", err.message);
  }

  // 2) 未命中 → 联网搜索（方案B）
  let webHits = [];
  let usedWeb = false;
  if (kbHits.length === 0) {
    try {
      webHits = await webSearch(question);
      usedWeb = webHits.length > 0;
    } catch (err) {
      console.warn("[ask] 联网搜索失败:", err.message);
    }
  }

  // 3) 组装 prompt 并交给 Pi agent
  const prompt = buildPrompt(question, kbHits, webHits);

  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [...base, EXPERT_PROMPT],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });

  let reply = "";
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = event.assistantMessageEvent.delta;
      reply += delta;
      onDelta(delta);
    }
  });

  await session.prompt(prompt);
  session.dispose();

  // 4) 结构化出处
  const sources = [
    ...kbHits.map((h) => ({ text: h.text, source: h.source, type: "知识库" })),
    ...webHits.map((h) => ({ text: h.text, source: h.url || h.title || "网络", type: "网络" })),
  ];

  return { reply, sources, usedWeb };
}
