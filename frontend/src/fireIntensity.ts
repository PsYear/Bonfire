export const MAX_BURN_INTENSITY = 400;

/** 100% 为标称火势；所有燃烧模块共用同一火势尺度。 */
export function burnPower(intensity: number, boost = 0): number {
  return Math.min(MAX_BURN_INTENSITY / 100 + 0.5,
    Math.max(0, intensity) / 100 + Math.max(0, boost) * 0.3);
}

/** 宽范围火势映射到现有 0–1 声音控制，音量仍由独立参数决定。 */
export function burnAudioLevel(intensity: number): number {
  return Math.sqrt(Math.max(0, Math.min(1, intensity / MAX_BURN_INTENSITY)));
}
