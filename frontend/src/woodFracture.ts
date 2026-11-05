/**
 * 顺木纹的深沟、错位横裂与分叉。几何凹陷、遮蔽和热红共用该场，
 * 不使用等尺寸 Voronoi 格子；每根木柴的裂缝位置和开口都不同。
 */
import { WOOD_VARIATIONS } from "./woodVariation";
export const FRACTURE_COLUMNS = 128;
export const FRACTURE_ROWS = 96;
const STRIDE = FRACTURE_COLUMNS + 1;

export interface FractureSample {
  depth: number;
  cavity: number;
  plate: number;
  ember: number;
}

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx *= fx * (3 - 2 * fx);
  fy *= fy * (3 - 2 * fy);
  const a = hash(ix, iy) * (1 - fx) + hash(ix + 1, iy) * fx;
  const b = hash(ix, iy + 1) * (1 - fx) + hash(ix + 1, iy + 1) * fx;
  return a * (1 - fy) + b * fy;
}

function smooth(a: number, b: number, n: number): number {
  const t = Math.max(0, Math.min(1, (n - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function wrap(d: number): number { return d - Math.round(d); }

function generate(log: number, cap = -1): Float32Array {
  const data = new Float32Array(STRIDE * (FRACTURE_ROWS + 1) * 4);
  const wood = WOOD_VARIATIONS[log];
  const seed = wood.seed + (cap + 1) * 271;
  const count = cap < 0 ? wood.longCracks : wood.capCracks + cap;
  const main = Array.from({ length: count }, (_, k) => ({
    u: (k + (hash(k, seed) - 0.5) * 0.76) / count,
    width: (0.005 + hash(k + 13, seed) * (cap < 0 ? 0.013 : 0.009)) * wood.crackWidth,
    depth: (0.16 + hash(k - 27, seed) * 0.25) * wood.crackDepth,
    phase: hash(k + 62, seed) * 100,
  }));
  const cross = Array.from({ length: cap < 0 ? wood.crossCracks : Math.round(wood.capCracks * 1.4) }, (_, k) => ({
    u: hash(k + 97, seed),
    v: 0.06 + hash(k - 41, seed) * 0.9,
    span: 0.029 + hash(k + 61, seed) ** 2 * (cap < 0 ? 0.14 : 0.12),
    width: (0.0035 + hash(k - 73, seed) * 0.01) * wood.crackWidth,
    depth: (0.13 + hash(k + 39, seed) * 0.21) * wood.crackDepth,
    phase: hash(k + 127, seed) * 100,
  }));
  const branches = main.slice(0, 5).map((line, k) => ({
    ...line,
    v: 0.15 + hash(k + 38, seed) * 0.65,
    span: 0.04 + hash(k + 52, seed) * 0.13,
    slope: (hash(k + 76, seed) - 0.5) * 0.95,
  }));
  for (let row = 0; row <= FRACTURE_ROWS; row += 1) {
    const v = row / FRACTURE_ROWS;
    for (let column = 0; column < FRACTURE_COLUMNS; column += 1) {
      const u = column / FRACTURE_COLUMNS;
      let depth = 0, cavity = 0, ember = 0;
      for (const line of main) {
        const drift = (noise(v * 3.5 + line.phase, seed) - 0.5) * 0.036
          + (noise(v * 21 + line.phase, seed + 7) - 0.5) * 0.009;
        const width = line.width * (0.45 + noise(v * 8 + line.phase, seed + 13) * 1.25);
        const d = Math.abs(wrap(u - line.u - drift));
        const open = 1 - smooth(width * 0.18, width, d);
        const ends = cap < 0 ? 1 : smooth(0.12 + hash(line.phase | 0, seed) * 0.3, 0.56, v);
        const gap = open * ends * (0.62 + noise(v * 6 + line.phase, seed + 19) * 0.38);
        depth = Math.max(depth, gap * line.depth);
        cavity = Math.max(cavity, gap);
        ember = Math.max(ember, gap * smooth(0.5, 0.78, noise(v * 13 + line.phase, seed + 23)) * 0.72);
      }
      for (const line of cross) {
        const du = wrap(u - line.u);
        if (Math.abs(du) >= line.span) continue;
        const taper = 1 - smooth(line.span * 0.55, line.span, Math.abs(du));
        const kink = (noise(du * 61 + line.phase, seed + 31) - 0.5) * 0.02
          + du * (hash(line.phase | 0, seed + 32) - 0.5) * 0.22;
        const width = line.width * (0.55 + noise(du * 33 + line.phase, seed + 35) * 0.85);
        const gap = (1 - smooth(width * 0.42, width, Math.abs(v - line.v - kink))) * taper;
        depth = Math.max(depth, gap * line.depth);
        cavity = Math.max(cavity, gap * 0.92);
        ember = Math.max(ember, gap * smooth(0.62, 0.85, noise(du * 29 + line.phase, seed + 41)) * 0.42);
      }
      for (const line of branches) {
        const dv = v - line.v;
        if (dv < 0 || dv > line.span) continue;
        const drift = (noise(line.v * 3.5 + line.phase, seed) - 0.5) * 0.036;
        const d = Math.abs(wrap(u - line.u - drift - dv * line.slope));
        const gap = (1 - smooth(line.width * 0.13, line.width * 0.6, d))
          * (1 - smooth(line.span * 0.5, line.span, dv));
        depth = Math.max(depth, gap * line.depth * 0.6);
        cavity = Math.max(cavity, gap * 0.84);
      }
      const a = u * Math.PI * 2;
      const plate = noise(Math.cos(a) * 3.4 + seed, v * 11 + Math.sin(a) * 3.4);
      const p = (row * STRIDE + column) * 4;
      data[p] = depth;
      data[p + 1] = cavity;
      data[p + 2] = plate;
      data[p + 3] = ember;
    }
    const first = row * STRIDE * 4, last = first + FRACTURE_COLUMNS * 4;
    data.set(data.subarray(first, first + 4), last);
  }
  return data;
}

const barkFields = Array.from({ length: 6 }, (_, log) => generate(log));
const capFields = Array.from({ length: 6 }, (_, log) => [generate(log, 0), generate(log, 1)]);

/** 双线性采样；out 复用，材质纹理生成过程中不分配逐像素对象。 */
export function sampleWoodFracture(log: number, u: number, v: number, out: FractureSample, cap = -1): void {
  const rawX = (u - Math.floor(u)) * FRACTURE_COLUMNS;
  const x = rawX >= FRACTURE_COLUMNS ? 0 : rawX;
  const y = Math.max(0, Math.min(FRACTURE_ROWS - 1e-6, v * FRACTURE_ROWS));
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const p = (iy * STRIDE + ix) * 4, stride = STRIDE * 4;
  const field = cap < 0 ? barkFields[log] : capFields[log][cap];
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
  out.depth = field[p] * a + field[p + 4] * b + field[p + stride] * c + field[p + stride + 4] * d;
  out.cavity = field[p + 1] * a + field[p + 5] * b + field[p + stride + 1] * c + field[p + stride + 5] * d;
  out.plate = field[p + 2] * a + field[p + 6] * b + field[p + stride + 2] * c + field[p + stride + 6] * d;
  out.ember = field[p + 3] * a + field[p + 7] * b + field[p + stride + 3] * c + field[p + stride + 7] * d;
}
