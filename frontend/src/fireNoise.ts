/** 连续的随机变化；无固定周期，适合缓慢阵风与木柴各处独立的燃料释放。 */
export function smoothNoise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (v: number): number => {
    const n = Math.sin(v * 127.1 + 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const t = f * f * (3 - 2 * f);
  return h(i) * (1 - t) + h(i + 1) * t;
}
