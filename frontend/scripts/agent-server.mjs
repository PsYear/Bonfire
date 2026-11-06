import { createServer } from "node:http";
import { chat, health, jsonResponse, MAX_BODY_BYTES } from "../server/agent-api.js";

const port = Number(process.env.BONFIRE_API_PORT ?? 8002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("BONFIRE_API_PORT 必须是有效端口");

createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/health" || path === "/api/health") return health(req, res);
  if (path !== "/chat" && path !== "/api/chat") return jsonResponse(res, 404, { detail: "接口不存在" });
  if (req.method !== "POST") return chat(req, res);
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        jsonResponse(res, 413, { detail: "对话内容过长，请缩短后重试" });
        req.resume();
        return;
      }
      chunks.push(chunk);
    }
    req.body = Buffer.concat(chunks).toString("utf8");
    await chat(req, res);
  } catch {
    if (!res.writableEnded) jsonResponse(res, 400, { detail: "无法读取对话请求" });
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Bonfire Agent API: http://127.0.0.1:${port}`);
});
