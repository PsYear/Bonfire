import { smoothNoise } from "./fireNoise";
import type { FireSceneConfig } from "./types";

export const MAX_WIND_FLOW = 3.2;

/** 绕竖直旗杆旋转：0° 向右，90° 向里，180° 向左，270° 向外。 */
export function angleWindDirection(angle: number): [number, number, number] {
  const radians = angle * Math.PI / 180;
  return [Math.cos(radians), 0, -Math.sin(radians)];
}

export function windDirectionAngle(x: number, z: number): number {
  return (Math.atan2(-z, x) * 180 / Math.PI + 360) % 360;
}

/** 屏幕滑动映射到地面风向：向上滑吹向场景里，轻微斜滑只加入少量纵深。 */
export function pointerWindDirection(dx: number, dy: number): [number, number, number] | null {
  const z = dy * 0.65;
  const length = Math.hypot(dx, z);
  return length > 0 ? [dx / length, 0, z / length] : null;
}

/** 定时吹向按活动时间分段，左/右时长独立，气体和风车保留自身惯性。 */
export function windDirectionInput(
  config: Pick<FireSceneConfig, "windMode" | "windDirection" | "windLeftSeconds" | "windRightSeconds">,
  elapsed: number,
  pointerDirection: number,
): number {
  if (config.windMode === "manual") return pointerDirection;
  const start = config.windDirection === "left" ? -1 : 1;
  if (config.windMode === "fixed") return start;
  const cycle = config.windLeftSeconds + config.windRightSeconds;
  const phase = Math.max(0, elapsed) % cycle;
  const firstSeconds = start < 0 ? config.windLeftSeconds : config.windRightSeconds;
  return phase < firstSeconds ? start : -start;
}

/** 风力决定大小，独立的方向输入决定吹向；0% 不产生风。 */
export function windFlow(strength: number, direction: number, time: number): number {
  const base = Math.max(0, Math.min(1, strength / 100)) ** 1.55 * MAX_WIND_FLOW;
  const gust = 0.86 + smoothNoise(time * 0.45 + 17.3) * 0.28;
  return base * Math.max(-1, Math.min(1, direction)) * gust;
}
