/** 一次加载生成一组稳定木柴；不同形态有不同尺寸、断裂与燃尽程度。 */
const sceneSeed = Math.floor(Math.random() * 2147483647);

function random(log: number, channel: number): number {
  let h = Math.imul(sceneSeed ^ (log * 1013 + channel * 7919), 374761393);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function between(log: number, channel: number, low: number, high: number): number {
  return low + random(log, channel) * (high - low);
}

const forms = [
  { kind: "gnarled", length: [2.35, 2.85], radius: [0.225, 0.285], ellipse: [1, 1],
    ash: 0.18, cracks: 6, cross: 29, depth: 0.72, bend: 0.24, taper: 0.16, end: [0.18, 0.42] },
  { kind: "stump", length: [1.2, 1.65], radius: [0.25, 0.3], ellipse: [0.9, 1.13],
    ash: 0.38, cracks: 13, cross: 65, depth: 1.28, bend: 0.16, taper: -0.1, end: [1.05, 0.23] },
  { kind: "split", length: [2, 2.55], radius: [0.175, 0.225], ellipse: [0.67, 1.25],
    ash: 0.46, cracks: 5, cross: 32, depth: 0.95, bend: 0.35, taper: -0.18, end: [0.26, 0.76] },
  { kind: "branch", length: [2.45, 2.9], radius: [0.105, 0.145], ellipse: [1, 0.85],
    ash: 0.12, cracks: 4, cross: 19, depth: 0.72, bend: 0.82, taper: 0.42, end: [0.1, 0.34] },
  { kind: "spent", length: [1.1, 1.5], radius: [0.18, 0.235], ellipse: [0.86, 1.15],
    ash: 0.91, cracks: 15, cross: 74, depth: 1.35, bend: 0.38, taper: 0.32, end: [0.95, 1.2] },
  { kind: "splinter", length: [1.65, 2.1], radius: [0.095, 0.14], ellipse: [0.56, 1.32],
    ash: 0.62, cracks: 7, cross: 43, depth: 1.05, bend: 0.6, taper: -0.36, end: [1.1, 0.36] },
];

export const WOOD_VARIATIONS = forms.map((form, log) => {
  const radius = between(log, 1, form.radius[0], form.radius[1]);
  const bendDirection = between(log, 2, 0, Math.PI * 2);
  const bend = radius * form.bend * between(log, 3, 0.7, 1.3);
  const endWear = form.end.map((amount, side) => amount * between(log, 4 + side, 0.65, 1.3));
  return {
    kind: form.kind,
    seed: Math.floor(random(log, 6) * 1000000),
    length: between(log, 7, form.length[0], form.length[1]),
    radius,
    ellipseX: form.ellipse[0] * between(log, 8, 0.88, 1.12),
    ellipseZ: form.ellipse[1] * between(log, 9, 0.88, 1.12),
    ellipseAngle: between(log, 10, -0.32, 0.32),
    splitDepth: form.kind === "split" || form.kind === "splinter" ? between(log, 11, 0.25, 0.48) : 1,
    taper: form.taper * between(log, 12, 0.7, 1.5),
    waist: between(log, 13, form.kind === "spent" ? 0.25 : 0.035, form.kind === "spent" ? 0.45 : 0.17),
    waistAt: between(log, 14, 0.25, 0.8),
    bendX: Math.cos(bendDirection) * bend,
    bendZ: Math.sin(bendDirection) * bend,
    sweepX: between(log, 15, -0.4, 0.4) * radius,
    sweepZ: between(log, 16, -0.4, 0.4) * radius,
    endWear,
    endCavity: endWear.map((wear, side) => wear * between(log, 17 + side, 0.28, 0.68)),
    endTilt: [between(log, 19, 0.03, 0.45), between(log, 20, 0.03, 0.45)],
    endAngle: [between(log, 21, 0, Math.PI * 2), between(log, 22, 0, Math.PI * 2)],
    chips: form.kind === "branch" ? 2 : form.kind === "spent" ? 7 : 3 + Math.floor(random(log, 23) * 4),
    ashAmount: Math.min(0.97, form.ash * between(log, 24, 0.8, 1.2)),
    charBase: form.kind === "spent" ? 0.8 : between(log, 25, 0.53, 0.69),
    heatBias: between(log, 26, 0.87, 1.1),
    longCracks: Math.max(3, form.cracks + Math.floor(between(log, 27, -2, 3))),
    crossCracks: Math.round(form.cross * between(log, 28, 0.7, 1.3)),
    capCracks: Math.round(between(log, 29, form.kind === "branch" ? 2 : 4, form.kind === "spent" ? 11 : 7)),
    crackWidth: between(log, 30, 0.65, form.kind === "stump" ? 1.85 : 1.4),
    crackDepth: form.depth * between(log, 31, 0.8, 1.1),
    grain: between(log, 32, 28, 83),
    microRelief: between(log, 33, 0.72, 1.45),
    charTint: [between(log, 34, 0.75, 1.15), between(log, 35, 0.78, 1.15), between(log, 36, 0.78, 1.15)],
    ashTint: [between(log, 37, 0.9, 1.05), between(log, 38, 0.92, 1.05), between(log, 39, 0.9, 1.06)],
  };
});

/** 局部中心线弯曲；端点不偏移，弯曲与轻微 S 形同时进入网格和碰撞。 */
export function woodBendX(log: number, v: number): number {
  const wood = WOOD_VARIATIONS[log], t = Math.max(0, Math.min(1, v));
  const bow = 4 * t * (1 - t);
  return bow * (wood.bendX + wood.sweepX * (t - 0.5) * 2);
}

export function woodBendZ(log: number, v: number): number {
  const wood = WOOD_VARIATIONS[log], t = Math.max(0, Math.min(1, v));
  const bow = 4 * t * (1 - t);
  return bow * (wood.bendZ + wood.sweepZ * (t - 0.5) * 2);
}
