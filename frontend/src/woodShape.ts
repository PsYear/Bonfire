/** 可见网格、燃烧表面与气体边界共用烧蚀轮廓；尺寸单位为世界单位。 */
import { FRACTURE_COLUMNS, FRACTURE_ROWS, sampleWoodFracture, type FractureSample } from "./woodFracture";
import { WOOD_VARIATIONS } from "./woodVariation";
export { woodBendX, woodBendZ } from "./woodVariation";
const LOG_POSITIONS = [
  [-0.22, 0.27, -0.21, 0.12, 2.6, 0.23],
  [0.13, 0.28, 0.21, 1.24, 2.42, 0.21],
  [0.11, 0.3, 0.03, 2.28, 2.5, 0.195],
  [-0.08, 0.56, 0.02, 0.65, 2.05, 0.19],
  [0.02, 0.59, -0.1, 1.8, 2.2, 0.2],
  [0.27, 0.43, 0.35, -0.36, 1.88, 0.155],
];
export const LOG_LAYOUT = LOG_POSITIONS.map(([x, y, z, angle], log) => {
  const wood = WOOD_VARIATIONS[log];
  const lower = Math.max(0.27, wood.radius * wood.ellipseX + Math.abs(wood.bendX) + 0.04);
  const elevation = log < 3 ? lower : log === 5 ? Math.max(0.3, lower) : Math.max(0.43, lower + 0.13);
  return [x, log < 3 ? lower : Math.min(y, elevation), z, angle, wood.length, wood.radius];
});

export const WOOD_SHAPE_COLUMNS = FRACTURE_COLUMNS;
export const WOOD_SHAPE_ROWS = FRACTURE_ROWS;
const STRIDE = WOOD_SHAPE_COLUMNS + 1;
const TAU = Math.PI * 2;

function smooth(a: number, b: number, n: number): number {
  const t = Math.max(0, Math.min(1, (n - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function angularDistance(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

const profiles = LOG_LAYOUT.map(([, , , , , radius], log) => {
  const radii = new Float32Array(STRIDE * (WOOD_SHAPE_ROWS + 1));
  const ashes = new Float32Array(radii.length);
  const ends = [new Float32Array(STRIDE), new Float32Array(STRIDE)];
  const wood = WOOD_VARIATIONS[log], seed = wood.seed * 0.0137;
  const fracture: FractureSample = { depth: 0, cavity: 0, plate: 0, ember: 0 };
  for (let row = 0; row <= WOOD_SHAPE_ROWS; row += 1) {
    const v = row / WOOD_SHAPE_ROWS;
    for (let column = 0; column < WOOD_SHAPE_COLUMNS; column += 1) {
      const a = column / WOOD_SHAPE_COLUMNS * TAU;
      const coarse = Math.sin(a * 3 + seed + v * 4.3) * 0.075
        + Math.sin(a * 7 - seed * 1.3 + v * 10.7) * 0.038;
      const ellipse = 1 / Math.hypot(Math.sin(a - wood.ellipseAngle) / wood.ellipseX,
        Math.cos(a - wood.ellipseAngle) / wood.ellipseZ);
      sampleWoodFracture(log, column / WOOD_SHAPE_COLUMNS, v, fracture);
      const plates = (fracture.plate - 0.5) * 0.085;
      const fissure = fracture.depth;
      let missing = 0, scarAsh = 0;
      // 各根木柴独立的缺块与烧空凹坑，部分缺口直接延伸到端部。
      for (let k = 0; k < wood.chips; k += 1) {
        const centerV = k === 0 ? 0.035 : k === wood.chips - 1 ? 0.95
          : 0.13 + (0.5 + Math.sin(seed * 1.21 + k * 17.3) * 0.5) * 0.73;
        const centerA = seed * 1.7 + k * 2.07;
        const d = angularDistance(a, centerA + Math.sin(v * 14 + seed) * 0.09);
        const crater = Math.exp(-((d / (0.36 + (k % 2) * 0.13)) ** 4)
          - ((v - centerV) / (0.055 + (k % 2) * 0.03)) ** 4);
        missing += crater * (0.22 + ((wood.seed + k) % 3) * 0.12);
        scarAsh = Math.max(scarAsh, crater * 0.55);
      }
      const endWear = Math.exp(-((v / 0.055) ** 2)) + Math.exp(-(((1 - v) / 0.07) ** 2));
      const waist = wood.waist * Math.exp(-(((v - wood.waistAt) / 0.13) ** 2));
      let ratio = Math.max(0.22, (0.86 + coarse + plates - fissure - missing
        - endWear * (0.04 + wood.endWear[v < 0.5 ? 0 : 1] * 0.17) - waist)
        * ellipse * (1 + wood.taper * (v - 0.5)));
      if (wood.splitDepth < 1 && Math.sin(a - wood.ellipseAngle) < -0.08) {
        ratio = Math.min(ratio, wood.splitDepth / -Math.sin(a - wood.ellipseAngle));
      }
      const powder = Math.sin(a * 2 + v * 13 + seed) * 0.29
        + Math.sin(a * 5 - v * 19 - seed) * 0.17
        + Math.sin(a * 11 + v * 43 + seed) * 0.07;
      const crust = smooth(0.34 - wood.ashAmount * 0.67, 0.58 - wood.ashAmount * 0.67, powder);
      const spentEnd = (1 - smooth(0.025, 0.17, Math.min(v, 1 - v)))
        * (0.3 + wood.ashAmount * 0.62) * (0.65 + 0.3 * Math.sin(a * 3 + seed) ** 2);
      const ash = Math.max(spentEnd, crust * (0.63 + wood.ashAmount * 0.3), scarAsh * wood.ashAmount);
      const i = row * STRIDE + column;
      radii[i] = radius * ratio;
      ashes[i] = Math.max(0, Math.min(1, ash * (1 - fracture.cavity * 0.93)));
    }
    radii[row * STRIDE + WOOD_SHAPE_COLUMNS] = radii[row * STRIDE];
    ashes[row * STRIDE + WOOD_SHAPE_COLUMNS] = ashes[row * STRIDE];
  }
  for (let side = 0; side < 2; side += 1) {
    for (let column = 0; column < WOOD_SHAPE_COLUMNS; column += 1) {
      const a = column / WOOD_SHAPE_COLUMNS * TAU;
      const chip = Math.exp(-((angularDistance(a, seed * 1.4 + side * 2.6) / 0.33) ** 4));
      ends[side][column] = radius * wood.endWear[side] * (0.12
        + (0.5 + Math.sin(a * 3 + seed + side * 2) * 0.5) * 0.35
        + (0.5 + Math.sin(a * 7 - seed + side) * 0.5) * 0.2 + chip * 0.68);
    }
    ends[side][WOOD_SHAPE_COLUMNS] = ends[side][0];
  }
  return { radii, ashes, ends, radius };
});

function columnPosition(u: number): number {
  const x = (u - Math.floor(u)) * WOOD_SHAPE_COLUMNS;
  // 极小的负角度可能被浮点舍入成正好 1；接缝必须回到第一列。
  return x >= WOOD_SHAPE_COLUMNS ? 0 : x;
}

function sample(field: Float32Array, u: number, v: number): number {
  const x = columnPosition(u);
  const y = Math.max(0, Math.min(WOOD_SHAPE_ROWS - 1e-6, v * WOOD_SHAPE_ROWS));
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const p = iy * STRIDE + ix;
  return (field[p] * (1 - fx) + field[p + 1] * fx) * (1 - fy)
    + (field[p + STRIDE] * (1 - fx) + field[p + STRIDE + 1] * fx) * fy;
}

export function woodRadius(log: number, u: number, v: number): number {
  return sample(profiles[log].radii, u, v);
}

/** 初始已经燃尽的外壳；裂缝内保持黑炭，灰壳呈不连续斑块。 */
export function woodInitialAsh(log: number, u: number, v: number): number {
  return sample(profiles[log].ashes, u, v);
}

/** 破碎端缘 + 向内烧蚀的凹面，radialFraction 为端面归一化半径。 */
export function woodEndInset(log: number, u: number, side: number, radialFraction = 1): number {
  const profile = profiles[log];
  const x = columnPosition(u);
  const ix = Math.floor(x), f = x - ix;
  const edge = profile.ends[side][ix] * (1 - f) + profile.ends[side][ix + 1] * f;
  const r = Math.max(0, Math.min(1, radialFraction));
  const wood = WOOD_VARIATIONS[log];
  sampleWoodFracture(log, u, r, endFracture, side);
  return Math.min(wood.length * 0.32, Math.max(profile.radius * 0.02, edge * smooth(0.08, 0.8, r)
    + profile.radius * (wood.endCavity[side] * (1 - r * r) + endFracture.depth * wood.endWear[side] * 0.7
      + wood.endTilt[side] * Math.sin(u * TAU - wood.endAngle[side]) * r)));
}

const endFracture: FractureSample = { depth: 0, cavity: 0, plate: 0, ember: 0 };
