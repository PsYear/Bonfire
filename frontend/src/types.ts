import { MAX_BURN_INTENSITY } from "./fireIntensity";

export type FlameTone = "ember" | "gold" | "white-hot";
export const FLAME_TONE_COLORS: Record<FlameTone, string> = {
  ember: "#FF742A", gold: "#FFA44E", "white-hot": "#FFC582",
};
export type InteractionMode = "cursor-wind" | "click-boost" | "both";
export type QualityPreset = "low" | "medium" | "high";
export type WindMode = "manual" | "fixed" | "alternating";
export type WindDirection = "left" | "right";

export interface FireSceneConfig {
  burnIntensity: number;
  windSpeed: number;
  windAngle: number;
  windMode: WindMode;
  windDirection: WindDirection;
  windLeftSeconds: number;
  windRightSeconds: number;
  environmentLight: number;
  volume: number;
  flameHeight: number;
  turbulence: number;
  smokeDensity: number;
  emberRate: number;
  sparkBurstFrequency: number;
  charGlowIntensity: number;
  flameTone: FlameTone;
  flameColor: string | null;
  environmentTemperature: number;
  fireLight: number;
  interactionMode: InteractionMode;
  quality: QualityPreset;
}

export type FireScenePatch = Partial<FireSceneConfig>;

export const DEFAULT_CONFIG: FireSceneConfig = {
  burnIntensity: 50,
  windSpeed: 10,
  windAngle: 90,
  windMode: "manual",
  windDirection: "left",
  windLeftSeconds: 1,
  windRightSeconds: 1,
  environmentLight: 20,
  volume: 55,
  flameHeight: 58,
  turbulence: 52,
  smokeDensity: 20,
  emberRate: 38,
  sparkBurstFrequency: 35,
  charGlowIntensity: 70,
  flameTone: "gold",
  flameColor: null,
  environmentTemperature: 42,
  fireLight: 72,
  interactionMode: "both",
  quality: "high",
};

export const PRESETS: Record<string, FireScenePatch> = {
  warm: {
    windMode: "manual",
    windAngle: 90,
    burnIntensity: 120,
    windSpeed: 8,
    environmentLight: 22,
    volume: 55,
    flameHeight: 58,
    turbulence: 48,
    smokeDensity: 18,
    emberRate: 34,
    sparkBurstFrequency: 35,
    charGlowIntensity: 70,
    flameTone: "gold",
    flameColor: null,
    environmentTemperature: 48,
    fireLight: 72,
  },
  embers: {
    windMode: "manual",
    windAngle: 90,
    burnIntensity: 15,
    windSpeed: 5,
    environmentLight: 9,
    volume: 32,
    flameHeight: 28,
    turbulence: 30,
    smokeDensity: 12,
    emberRate: 18,
    sparkBurstFrequency: 12,
    charGlowIntensity: 85,
    flameTone: "ember",
    flameColor: null,
    environmentTemperature: 28,
    fireLight: 45,
  },
  blaze: {
    windMode: "manual",
    windAngle: 90,
    burnIntensity: 300,
    windSpeed: 18,
    environmentLight: 28,
    volume: 72,
    flameHeight: 84,
    turbulence: 70,
    smokeDensity: 28,
    emberRate: 76,
    sparkBurstFrequency: 75,
    charGlowIntensity: 65,
    flameTone: "white-hot",
    flameColor: null,
    environmentTemperature: 56,
    fireLight: 92,
  },
};

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolLabel?: string;
  error?: boolean;
  usage?: TokenUsage;
}

export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface AgentToolCall {
  name: "update_fire_scene" | "reset_fire_scene";
  arguments?: {
    patch?: FireScenePatch;
  };
}

export interface AgentResponse {
  reply: string;
  tool_calls: AgentToolCall[];
}

export const NUMERIC_LIMITS: Record<
  keyof Pick<
    FireSceneConfig,
    | "burnIntensity"
    | "windSpeed"
    | "windAngle"
    | "windLeftSeconds"
    | "windRightSeconds"
    | "environmentLight"
    | "volume"
    | "flameHeight"
    | "turbulence"
    | "smokeDensity"
    | "emberRate"
    | "sparkBurstFrequency"
    | "charGlowIntensity"
    | "environmentTemperature"
    | "fireLight"
  >,
  [number, number]
> = {
  burnIntensity: [0, MAX_BURN_INTENSITY],
  windSpeed: [0, 100],
  windAngle: [0, 360],
  windLeftSeconds: [0.1, 60],
  windRightSeconds: [0.1, 60],
  environmentLight: [0, 100],
  volume: [0, 100],
  flameHeight: [0, 100],
  turbulence: [0, 100],
  smokeDensity: [0, 100],
  emberRate: [0, 100],
  sparkBurstFrequency: [0, 100],
  charGlowIntensity: [0, 100],
  environmentTemperature: [0, 100],
  fireLight: [0, 100],
};

export function clampConfigPatch(patch: FireScenePatch): FireScenePatch {
  const safe: FireScenePatch = {};
  for (const [key, range] of Object.entries(NUMERIC_LIMITS)) {
    const value = patch[key as keyof FireScenePatch];
    if (typeof value === "number" && Number.isFinite(value)) {
      (safe as Record<string, unknown>)[key] = Math.min(range[1], Math.max(range[0], value));
    }
  }
  if (["ember", "gold", "white-hot"].includes(patch.flameTone ?? "")) {
    safe.flameTone = patch.flameTone;
    safe.flameColor = null;
  }
  if (patch.flameColor === null) {
    safe.flameColor = null;
  } else if (typeof patch.flameColor === "string" && /^#(?:[0-9a-f]{6}|[0-9a-f]{3})$/i.test(patch.flameColor.trim())) {
    const hex = patch.flameColor.trim().slice(1);
    safe.flameColor = `#${hex.length === 3 ? [...hex].map(char => char + char).join("") : hex}`.toUpperCase();
  }
  if (["cursor-wind", "click-boost", "both"].includes(patch.interactionMode ?? "")) {
    safe.interactionMode = patch.interactionMode;
  }
  if (["low", "medium", "high"].includes(patch.quality ?? "")) {
    safe.quality = patch.quality;
  }
  if (["manual", "fixed", "alternating"].includes(patch.windMode ?? "")) {
    safe.windMode = patch.windMode;
  }
  if (["left", "right"].includes(patch.windDirection ?? "")) {
    safe.windDirection = patch.windDirection;
  }
  return safe;
}
