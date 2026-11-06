import { SCENE_TOOLS, sceneResponse } from "./agent-protocol.js";

const MODEL = "glm-5.3-flash";
const MODEL_URL = "https://open.bigmodel.cn/api/anthropic/v1/messages";
export const MAX_BODY_BYTES = 64 * 1024;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function tokenUsage(value) {
  const count = (number) =>
    typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
  return {
    input_tokens: count(value?.input_tokens),
    output_tokens: count(value?.output_tokens),
  };
}

function requestPayload(body) {
  if (typeof body === "string") {
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new RequestError(413, "对话内容过长，请缩短后重试");
    try {
      body = JSON.parse(body);
    } catch {
      throw new RequestError(400, "请求内容不是有效的 JSON");
    }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "请提供有效的对话内容");
  }
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) {
    throw new RequestError(413, "对话内容过长，请缩短后重试");
  }
  const messages = body.messages ?? [];
  if (!Array.isArray(messages)) throw new RequestError(400, "messages 必须是对话列表");
  const conversation = [...messages];
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    conversation.push({ role: "user", content: body.prompt });
  }
  if (!conversation.length || conversation.length > 12 ||
      conversation.some((message) =>
        !message || !["user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" || !message.content.trim() ||
        message.content.length > 16000)) {
    throw new RequestError(400, "请提供 1–12 条有效的用户或助手消息");
  }
  if (body.system !== undefined && (typeof body.system !== "string" || body.system.length > 16000)) {
    throw new RequestError(400, "场景指令格式不正确或内容过长");
  }
  if (body.model !== undefined && body.model !== MODEL) {
    throw new RequestError(400, "当前 Agent 使用 GLM 5.3 Flash");
  }
  const temperature = body.temperature ?? 0.2;
  const maxTokens = body.max_tokens ?? 1400;
  if (typeof temperature !== "number" || !Number.isFinite(temperature) ||
      temperature < 0 || temperature > 1 ||
      !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    throw new RequestError(400, "模型参数超出允许范围");
  }
  return {
    model: MODEL,
    messages: conversation.map(({ role, content }) => ({ role, content })),
    ...(body.system ? { system: body.system } : {}),
    temperature,
    max_tokens: maxTokens,
    tools: SCENE_TOOLS,
    tool_choice: { type: "auto" },
    stream: false,
  };
}

/** 只转发当前请求的 Key；不读取服务端密钥，也不记录请求或上游正文。 */
export async function chat(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonResponse(res, 405, { detail: "请使用 POST 发送对话" });
  }
  const authorization = req.headers?.authorization;
  const match = typeof authorization === "string" && /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(authorization);
  if (!match) return jsonResponse(res, 401, { detail: "请先在页面输入 API Key" });
  const apiKey = match[1];
  if (!/^[\x21-\x7e]{1,512}$/.test(apiKey)) {
    return jsonResponse(res, 400, { detail: "请提供有效的 API Key" });
  }
  let payload;
  try {
    payload = requestPayload(req.body);
  } catch (error) {
    return jsonResponse(res, error instanceof RequestError ? error.status : 400, {
      detail: error instanceof RequestError ? error.message : "请提供有效的对话内容",
    });
  }
  try {
    const response = await fetch(MODEL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(55000),
      redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return jsonResponse(res, response.status, { detail: "API Key 无效或没有模型访问权限，请重新设置" });
      }
      if (response.status === 429) {
        return jsonResponse(res, 429, { detail: "模型额度不足或请求过于频繁，请检查额度后重试" });
      }
      return jsonResponse(res, 502, { detail: `模型服务返回 ${response.status}，请稍后重试` });
    }
    let result;
    try {
      result = await response.json();
    } catch {
      return jsonResponse(res, 502, { detail: "模型服务返回了无效的 JSON" });
    }
    const usage = tokenUsage(result?.usage);
    let normalized;
    try {
      normalized = sceneResponse(result);
    } catch (error) {
      return jsonResponse(res, 502, {
        detail: error.message,
        usage,
      });
    }
    return jsonResponse(res, 200, {
      response: normalized,
      content: JSON.stringify(normalized),
      model: MODEL,
      usage,
    });
  } catch (error) {
    return jsonResponse(res, error?.name === "TimeoutError" || error?.name === "AbortError" ? 504 : 502, {
      detail: error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "模型请求超时，请稍后重试" : "暂时无法连接模型服务，请稍后重试",
    });
  }
}

export function health(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return jsonResponse(res, 405, { detail: "请使用 GET 检查服务状态" });
  }
  if (req.method === "HEAD") {
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 200;
    return res.end();
  }
  return jsonResponse(res, 200, { status: "ok", model: MODEL });
}
