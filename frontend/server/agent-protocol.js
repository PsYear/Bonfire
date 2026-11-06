const number = (minimum = 0, maximum = 100) => ({ type: "number", minimum, maximum });
const choice = (...values) => ({ type: "string", enum: values });

const PATCH_PROPERTIES = {
  burnIntensity: number(0, 400),
  windSpeed: number(),
  windAngle: number(0, 360),
  windMode: choice("manual", "fixed", "alternating"),
  windDirection: choice("left", "right"),
  windLeftSeconds: number(0.1, 60),
  windRightSeconds: number(0.1, 60),
  environmentLight: number(),
  volume: number(),
  flameHeight: number(),
  turbulence: number(),
  smokeDensity: number(),
  emberRate: number(),
  sparkBurstFrequency: number(),
  charGlowIntensity: number(),
  flameTone: choice("ember", "gold", "white-hot"),
  flameColor: { type: ["string", "null"], pattern: "^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$" },
  environmentTemperature: number(),
  fireLight: number(),
  interactionMode: choice("cursor-wind", "click-boost", "both"),
  quality: choice("low", "medium", "high"),
};

export const SCENE_TOOLS = [
  {
    name: "update_fire_scene",
    description: "增量修改实时篝火。根据用户的主题或风格选择现有参数，patch 只包含需要修改的项；reply 简短说明所做调整。",
    input_schema: {
      type: "object",
      properties: {
        patch: { type: "object", properties: PATCH_PROPERTIES, additionalProperties: false, minProperties: 1 },
        reply: { type: "string", description: "给用户的简短中文说明" },
      },
      required: ["patch", "reply"],
      additionalProperties: false,
    },
  },
  {
    name: "reset_fire_scene",
    description: "用户要求重置时恢复默认篝火参数。",
    input_schema: {
      type: "object",
      properties: { reply: { type: "string", description: "给用户的简短中文说明" } },
      required: ["reply"],
      additionalProperties: false,
    },
  },
];

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => new Error("模型返回的场景参数无效，请重试");

function toolCall(value) {
  if (!object(value)) throw invalid();
  const name = value.name ?? value.function?.name;
  if (name !== "update_fire_scene" && name !== "reset_fire_scene") {
    throw new Error("模型调用了未知工具，请重试");
  }
  let input = value.input ?? value.arguments ?? value.function?.arguments ?? {};
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw invalid();
    }
  }
  if (!object(input)) throw invalid();
  if (input.reply !== undefined && typeof input.reply !== "string") throw invalid();
  const reply = input.reply?.trim() ?? "";
  if (name === "reset_fire_scene") return { call: { name }, reply };
  if (!object(input.patch) || !Object.keys(input.patch).length) throw invalid();
  const patch = {};
  for (const [key, value] of Object.entries(input.patch)) {
    const schema = PATCH_PROPERTIES[key];
    if (!Object.hasOwn(PATCH_PROPERTIES, key)) throw invalid();
    if (schema.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw invalid();
      patch[key] = Math.min(schema.maximum, Math.max(schema.minimum, value));
    } else if (key === "flameColor") {
      if (value === null) patch[key] = null;
      else if (typeof value === "string" && new RegExp(schema.pattern).test(value.trim())) {
        const hex = value.trim().slice(1);
        patch[key] = `#${hex.length === 3 ? [...hex].map(char => char + char).join("") : hex}`.toUpperCase();
      } else throw invalid();
    } else {
      if (!schema.enum.includes(value)) throw invalid();
      patch[key] = value;
    }
  }
  // 和前端预设色调的行为保持一致：切换色调会清除自定义颜色。
  if (patch.flameTone !== undefined && patch.flameColor === undefined) patch.flameColor = null;
  return { call: { name, arguments: { patch } }, reply };
}

function jsonObjects(text) {
  const values = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (depth === 0) {
      if (char === "{") {
        start = index;
        depth = 1;
        quoted = false;
        escaped = false;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        values.push(JSON.parse(text.slice(start, index + 1)));
      } catch {
        // 继续寻找后续完整对象，避免正文中的示例或代码块干扰最终回复。
      }
    }
  }
  return values;
}

function normalized(reply, calls) {
  if (!Array.isArray(calls)) throw invalid();
  const parsed = calls.map(toolCall);
  return {
    reply: parsed.map(value => value.reply).filter(Boolean).join("\n") ||
      (typeof reply === "string" ? reply.trim() : "") ||
      (calls.length ? "已更新篝火参数。" : "当前无需调整篝火参数。"),
    tool_calls: parsed.map(value => value.call),
  };
}

/** 将原生工具调用或旧版 JSON 回复统一成前端协议；验证失败时不执行任何修改。 */
export function sceneResponse(result) {
  if (result?.stop_reason === "max_tokens") throw new Error("模型回复被截断，请缩短指令后重试");
  if (result?.stop_reason === "refusal") throw new Error("模型拒绝了该请求");
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const text = blocks.filter(block => block?.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("\n").trim();
  const calls = blocks.filter(block => block?.type === "tool_use");
  if (calls.length) return normalized(text, calls);

  const values = jsonObjects(text);
  const response = values.findLast(value => object(value) && Object.hasOwn(value, "tool_calls"));
  if (response) return normalized(response.reply, response.tool_calls);
  const call = values.findLast(value => object(value) &&
    (Object.hasOwn(value, "name") || Object.hasOwn(value, "function")));
  if (call) return normalized("", [call]);
  const reply = values.findLast(value => object(value) && typeof value.reply === "string");
  if (reply) return normalized(reply.reply, []);
  if (!text) throw new Error("模型响应缺少正文或工具调用，请重试");
  if (/"(?:tool_calls|update_fire_scene|reset_fire_scene|patch)"\s*:|<tool_call>|"name"\s*:\s*"(?:update|reset)_fire_scene"/.test(text)) {
    throw new Error("模型工具调用不完整，请重试");
  }
  return { reply: text, tool_calls: [] };
}
