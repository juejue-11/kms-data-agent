// server.js
import express from "express";
import cors from "cors";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { askPCB } from "./rag/ask.js";

const app = express();
const PORT = process.env.PORT || 9100;
const __dirname = fileURLToPath(new URL(".", import.meta.url));

app.use(cors());
app.use(express.json());
// 同时托管前端（含 vendor 下的浏览器端第三方库），启动后直接访问 http://localhost:9100
app.use(express.static(join(__dirname, "web-ui")));

app.post("/api/chat", async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "消息不能为空" });

  try {
    const { reply, sources, usedWeb } = await askPCB(message);
    res.json({ reply, sources, usedWeb });
  } catch (error) {
    console.error("[chat] Agent 处理出错:", error);
    res.status(500).json({ error: "Agent 处理失败，请查看后端日志" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`后端服务已启动: http://0.0.0.0:${PORT}`);
});
