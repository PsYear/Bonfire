import {
  DEFAULT_CONFIG,
  clampConfigPatch,
  type AgentResponse,
  type ChatMessage,
  type FireSceneConfig,
  type FireScenePatch,
  type TokenUsage,
} from "./types";

const SYSTEM_PROMPT = `你是 Bonfire 篝火工作台中的场景控制 Agent。你只能通过工具修改实时篝火。

可用工具：
1. update_fire_scene：增量修改场景。arguments.patch 可包含：
- burnIntensity：0 到 400 的数字，默认 50；0 熄火，低档微火，100 为标称火势，300 到 400 为极强火势
- windSpeed, environmentLight, volume, flameHeight, turbulence,
  smokeDensity, emberRate, sparkBurstFrequency, charGlowIntensity, environmentTemperature, fireLight：0 到 100 的数字
- windMode："manual"（风向滑块/鼠标按住拖动/左右方向键） | "fixed"（固定吹向） | "alternating"（定时左右循环）
- windAngle：0 到 360 度，默认 90（正前方向场景里吹）；0/360 向右，90 向场景里，180 向左，270 向场景外，设置角度时同时设置 windMode="manual"
- windDirection："left" | "right"；固定模式为吹向，循环模式为先吹的方向
- windLeftSeconds, windRightSeconds：0.1 到 60 秒的数字，默认各 1 秒
- flameTone："ember" | "gold" | "white-hot"
- flameColor："#RRGGBB" 格式的十六进制颜色；null 恢复预设色调
- interactionMode："cursor-wind" | "click-boost" | "both"
- quality："low" | "medium" | "high"
2. reset_fire_scene：恢复默认状态。

规则：
- 理解多轮上下文；“再慢一点”应在当前值基础上减小相关速度或湍流。
- 用户说只改某项时，patch 只能包含该项。
- 火焰会持续维持设定火势，不会因观看时间自然燃尽；只有用户要求熄火才把 burnIntensity 调到 0。
- 风车的转速、晃动和火焰侧吹由 windSpeed 控制，强风用 70 到 100；鼠标风向也联动风车。
- 鼠标风向只在按住左键拖动时更新：向右拖向右吹，向左拖向左吹；上拖偏向场景里，下拖偏向场景外，松开后保留风向。单击场景添柴，每次火势增加 10 个百分点，最高 400%，拖动不触发添柴。风力由 windSpeed 控制。
- 键盘 ↑/↓ 每次增减 10 个百分点火势，←/→ 每次转动 10 度风向；左右键会接管自动风向，保持原有风力。输入框及滑块内的方向键保留原有操作。
- 支持按时间左右循环吹风，使用 windMode="alternating"、windDirection 指定先吹方向，以及左右各自时长；循环自动持续，鼠标不干扰。
- “帮我1秒往左吹，1秒往右吹，循环”必须调用 update_fire_scene，patch 为 {"windMode":"alternating","windDirection":"left","windLeftSeconds":1,"windRightSeconds":1}，不能回复不支持。若当前 windSpeed 为 0，额外设为 40；否则保留风力。
- “左2秒右3秒循环”设置对应时长；已有循环中的“改成每边2秒”只改左右时长。其他场景参数修改不停止或重启循环。
- “停止循环/恢复鼠标风向”设置 windMode="manual"；“一直向左/固定向右”设置 windMode="fixed" 和对应 windDirection。暂停会冻结循环，恢复后继续。
- “风向调到135度/往场景里吹”等任意角度使用 windAngle 和 windMode="manual"，保留风力；右侧小旗子和滑块同步显示风向，拖动滑块会接管 Agent 自动风向。
- “两侧爆裂频率”用 sparkBurstFrequency；数值越大，左右火星向外喷溅越频繁，0 关闭自动爆裂。它独立于 emberRate（持续火星数量）。
- “木柴烧红/炭火红热亮度/暗红余烬明暗”用 charGlowIntensity；数值越大，已有热炭的红光越明显，0 关闭红热光。只调此项时保持火势、火光强度和火焰色调。
- 支持任意火焰颜色。绿色、紫色、蓝色等描述必须选取对应十六进制颜色并调用 update_fire_scene，patch 只含 flameColor，回复简短说明所选色值；例如绿色 "#00FF66"、紫色 "#9B30FF"、蓝色 "#0066FF"。不能回复颜色不支持，也不能强行映射为金黄或白热。
- 用户给出具体十六进制色值时原样采用该颜色；“更偏蓝/浅一点”等在当前颜色基础上调整 flameColor。只改颜色时保留火势、风力、风向循环与其余参数。
- “自然金黄/暗红余烬/白热中心”使用对应 flameTone；“恢复自然颜色/取消自定义颜色”设置 flameColor=null。预设色调会清除自定义颜色。
- 用户提出游戏、幻想或其他主题时，主动用现有火焰、火星、烟雾和灯光参数营造对应氛围；不声称添加了当前场景没有的模型、纹理或物件。
- 不支持或确实无法确定的指令不调用工具，简短说明。
- 不编造渲染进度，不输出 Markdown。
- 修改场景必须调用提供的原生工具 update_fire_scene 或 reset_fire_scene，工具参数 reply 为给用户的简短中文说明；一次调整尽量合并到一个 patch。
- 不要在正文中手写 JSON、tool_calls 或工具调用代码。
- 普通聊天或无需修改时直接用自然语言回复；没有调用工具时不得声称已经修改了场景。`;

interface ApiResponse {
  response?: unknown;
  content?: string;
  detail?: string;
  usage?: Partial<TokenUsage> | null;
}

export class AgentRequestError extends Error {
  constructor(message: string, public readonly usage?: TokenUsage) {
    super(message);
  }
}

function tokenUsage(value: ApiResponse["usage"]): TokenUsage {
  const count = (number: unknown): number | null =>
    typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
  return {
    input_tokens: count(value?.input_tokens),
    output_tokens: count(value?.output_tokens),
  };
}

export class BonfireAgent {
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];

  async send(
    prompt: string,
    config: FireSceneConfig,
    apiKey: string,
  ): Promise<{ response: AgentResponse; userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    if (!apiKey.trim()) throw new AgentRequestError("请先输入 API Key");
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
    };
    const messages = [
      ...this.history.slice(-10),
      {
        role: "user" as const,
        content: `${prompt}\n\n当前场景状态：${JSON.stringify(config)}`,
      },
    ];

    let request: Response;
    try {
      request = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey.trim()}` },
        signal: AbortSignal.timeout(65000),
        body: JSON.stringify({
          messages,
          system: SYSTEM_PROMPT,
          model: "glm-5.3-flash",
          temperature: 0.2,
          max_tokens: 1400,
        }),
      });
    } catch (error) {
      throw new AgentRequestError(
        error instanceof DOMException && error.name === "TimeoutError"
          ? "模型请求超时，请稍后重试" : "无法连接模型接口，请检查网络与服务状态",
      );
    }
    let result: ApiResponse;
    try {
      result = (await request.json()) as ApiResponse;
    } catch {
      throw new AgentRequestError(`模型接口返回异常（${request.status}），请稍后重试`);
    }
    if (!request.ok || (!result.response && !result.content)) {
      const detail = typeof result.detail === "string" ? result.detail : `模型服务返回 ${request.status}`;
      throw new AgentRequestError(
        detail.replaceAll(apiKey.trim(), "[已隐藏]"),
        result.usage ? tokenUsage(result.usage) : request.ok ? tokenUsage(null) : undefined,
      );
    }

    const usage = tokenUsage(result.usage);
    let parsed: AgentResponse;
    try {
      parsed = this.parseResponse(result.response ?? JSON.parse(result.content!));
    } catch {
      throw new AgentRequestError("无法解析模型工具调用，请重试", usage);
    }
    this.history.push(
      { role: "user", content: prompt },
      { role: "assistant", content: JSON.stringify(parsed) },
    );
    const toolLabel =
      parsed.tool_calls.length > 0
        ? parsed.tool_calls[0].name === "reset_fire_scene"
          ? "reset_fire_scene"
          : "update_fire_scene"
        : undefined;
    return {
      response: parsed,
      userMessage,
      assistantMessage: {
        id: crypto.randomUUID(),
        role: "assistant",
        content: parsed.reply,
        toolLabel,
        usage,
      },
    };
  }

  clear(): void {
    this.history = [];
  }

  private parseResponse(raw: unknown): AgentResponse {
    if (!raw || typeof raw !== "object") throw new Error("模型响应无效");
    const value = raw as Partial<AgentResponse>;
    if (typeof value.reply !== "string" || !Array.isArray(value.tool_calls)) {
      throw new Error("模型响应结构不完整");
    }
    const tool_calls = value.tool_calls.map((call) => {
      if (call?.name === "reset_fire_scene") return { name: call.name };
      if (call?.name !== "update_fire_scene" || !call.arguments?.patch ||
          typeof call.arguments.patch !== "object" || Array.isArray(call.arguments.patch)) {
        throw new Error("模型工具调用无效");
      }
      const patch = clampConfigPatch(call.arguments.patch as FireScenePatch);
      if (!Object.keys(patch).length) throw new Error("模型场景参数无效");
      return { name: call.name, arguments: { patch } };
    });
    return { reply: value.reply, tool_calls };
  }
}

export function initialAssistantMessage(): ChatMessage {
  return {
    id: "initial",
    role: "assistant",
    content: `火势稳定在 ${DEFAULT_CONFIG.burnIntensity}%。告诉我你想要怎样的火焰，我会直接调整现场。`,
  };
}
