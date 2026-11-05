import * as THREE from "three";
import { FIRE_SOURCES, WOOD_SOLIDS, solidDistance, woodSurface } from "./firePhysics";
import { smoothNoise } from "./fireNoise";
import { woodBendX, woodBendZ, woodEndInset, woodInitialAsh, woodRadius } from "./woodShape";
import { WOOD_VARIATIONS } from "./woodVariation";
import { DEFAULT_CONFIG } from "./types";
import { burnPower } from "./fireIntensity";

export const WOOD_COLUMNS = 48;
export const WOOD_ROWS = 48;
const CELLS_PER_LOG = WOOD_COLUMNS * WOOD_ROWS;
const COUNT = CELLS_PER_LOG * WOOD_SOLIDS.length;
const STEP = 1 / 15;
const CHAR_YIELD = 0.26;
const FLUX_SCALE = 0.007;

function smooth(a: number, b: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export interface WoodStatistics {
  temperatureC: [number, number];
  virginFuelRemaining: number;
  solidMassLost: number;
  charCoverage: number;
  ashCoverage: number;
  hotSurfaceFraction: number;
  pyrolysisRate: number;
  fuelConsumed: number;
}

/**
 * 持续燃烧的表面热模型：补充反应消耗的库存，保持初始炭化/灰壳形态。
 * 燃料输出、局部温度和可见材质共用状态，只有主动关火才停止释放燃料。
 * 温度单位为摄氏度；反应系数用于实时近似，不是经过标定的化学动力学。
 */
export class WoodCombustion {
  readonly texture: THREE.DataTexture;
  readonly sourceActivity = new Float32Array(FIRE_SOURCES.length);
  private readonly pixels = new Float32Array(COUNT * 4);
  private readonly temperature = new Float32Array(COUNT);
  private readonly initialTemperature = new Float32Array(COUNT);
  private readonly nextTemperature = new Float32Array(COUNT);
  private readonly virgin = new Float32Array(COUNT);
  private readonly charFuel = new Float32Array(COUNT);
  private readonly converted = new Float32Array(COUNT);
  private readonly ash = new Float32Array(COUNT);
  private readonly heating = new Float32Array(COUNT);
  private readonly exposure = new Float32Array(COUNT);
  private readonly ventActivity = new Float32Array(COUNT);
  private readonly ventGrid = new Float32Array(WOOD_SOLIDS.length * 5 * 7);
  private readonly probes = new Float32Array(COUNT * 3);
  private readonly sourceCells = new Int32Array(FIRE_SOURCES.length);
  private readonly point = new THREE.Vector3();
  private accumulator = 0;
  private elapsed = 0;
  private readonly ventSeed = Math.random() * 1000;
  private bedTemperature = 760;
  private fuelConsumed = 0;
  private initialVirgin = 0;
  private initialMass = 0;
  private statistics!: WoodStatistics;

  constructor() {
    const normal = new THREE.Vector3();
    WOOD_SOLIDS.forEach((solid, log) => {
      for (let v = 0; v < WOOD_ROWS; v += 1) {
        for (let u = 0; u < WOOD_COLUMNS; u += 1) {
          const index = log * CELLS_PER_LOG + v * WOOD_COLUMNS + u;
          const theta = (u + 0.5) / WOOD_COLUMNS * Math.PI * 2;
          const uv = (u + 0.5) / WOOD_COLUMNS, vv = (v + 0.5) / WOOD_ROWS;
          const bottom = -solid.length + woodEndInset(log, uv, 0);
          const top = solid.length - woodEndInset(log, uv, 1);
          const surfaceY = THREE.MathUtils.clamp((vv - 0.5) * solid.length * 2, bottom, top);
          normal.copy(solid.radialX).multiplyScalar(Math.sin(theta))
            .addScaledVector(solid.radialZ, Math.cos(theta));
          this.point.copy(solid.center)
            .addScaledVector(solid.axis, surfaceY)
            .addScaledVector(solid.radialX, woodBendX(log, surfaceY / (solid.length * 2) + 0.5))
            .addScaledVector(solid.radialZ, woodBendZ(log, surfaceY / (solid.length * 2) + 0.5))
            .addScaledVector(normal, woodRadius(log, uv, surfaceY / (solid.length * 2) + 0.5) + 0.065);
          this.probes.set(this.point.toArray(), index * 3);
          const axial = (v + 0.5) / WOOD_ROWS - 0.5;
          const core = Math.exp(-axial * axial * 8)
            * Math.exp(-(this.point.x ** 2 + this.point.z ** 2) * 0.65);
          const patch = 0.5 + 0.24 * Math.sin(theta * 3 + v * 0.19 + log * 2.7)
            + 0.16 * Math.sin(theta * 7 - v * 0.32 + log * 1.4);
          const heated = core * (0.52 + patch * 0.64) * WOOD_VARIATIONS[log].heatBias;
          const ash = woodInitialAsh(log, uv, vv);
          const converted = Math.min(1, WOOD_VARIATIONS[log].charBase
            + smooth(0.1, 0.8, heated) * 0.18 + ash * 0.3);
          this.temperature[index] = 95 + heated * 795 * (1 - ash * 0.76);
          this.virgin[index] = 1 - converted;
          this.charFuel[index] = Math.max(0, converted - ash) * CHAR_YIELD;
          this.converted[index] = converted;
          this.ash[index] = Math.min(converted, ash);
          this.heating[index] = core * (0.65 + patch * 0.5) * (1 - ash * 0.6);
          // 接触木柴内部的位置缺少空气，但仍可传热。
          this.exposure[index] = solidDistance(this.point) > 0.01 ? 1 : 0.18;
          this.initialVirgin += this.virgin[index];
          this.initialMass += this.virgin[index] + this.charFuel[index];
        }
      }
    });
    FIRE_SOURCES.forEach((source, index) => {
      woodSurface(this.point.set(source.x, source.y, source.z), normal);
      this.sourceCells[index] = this.cellAt(normal.z, normal.x, normal.y);
    });
    this.initialTemperature.set(this.temperature);
    this.texture = new THREE.DataTexture(
      this.pixels, WOOD_COLUMNS, WOOD_ROWS * WOOD_SOLIDS.length, THREE.RGBAFormat, THREE.FloatType,
    );
    this.texture.minFilter = this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.updateVents();
    this.pack(burnPower(DEFAULT_CONFIG.burnIntensity));
  }

  update(delta: number, burn: number, wind: number, sampleGasTemperature: (p: THREE.Vector3) => number): void {
    this.accumulator += delta;
    if (this.accumulator < STEP) return;
    const dt = Math.min(this.accumulator, STEP * 2);
    this.accumulator = 0;
    this.elapsed += dt;
    this.updateVents();
    const active = smooth(0.0001, 0.03, burn);
    const oxygen = active * burn * 1.65;
    const targetBed = 620 + 210 * (1 - Math.exp(-Math.max(0, burn) * 0.65));
    this.bedTemperature = THREE.MathUtils.damp(this.bedTemperature,
      active > 0 ? targetBed : 20, active > 0 ? 0.45 : 0.035, dt);
    for (let i = 0; i < COUNT; i += 1) {
      const t = this.temperature[i];
      const local = i % CELLS_PER_LOG, u = local % WOOD_COLUMNS, v = Math.floor(local / WOOD_COLUMNS);
      const base = i - local;
      const left = base + v * WOOD_COLUMNS + (u + WOOD_COLUMNS - 1) % WOOD_COLUMNS;
      const right = base + v * WOOD_COLUMNS + (u + 1) % WOOD_COLUMNS;
      const below = base + Math.max(0, v - 1) * WOOD_COLUMNS + u;
      const above = base + Math.min(WOOD_ROWS - 1, v + 1) * WOOD_COLUMNS + u;
      const conduction = (this.temperature[left] + this.temperature[right] - 2 * t) * 0.22
        + (this.temperature[below] + this.temperature[above] - 2 * t) * 0.15;
      this.point.fromArray(this.probes, i * 3);
      const gas = 20 + sampleGasTemperature(this.point) * 1050;
      const transfer = Math.max(gas - t, 0) * 0.48 - Math.max(t - gas, 0) * 0.025;
      const pyrolysis = this.pyrolysis(i, oxygen);
      const charBurn = Math.min(this.charFuel[i] / dt,
        // 高温时由表面供氧限制反应，避免炭温度指数反馈失控。
        this.charFuel[i] * 0.006 * Math.exp(THREE.MathUtils.clamp((t - 520) / 220, -3, 0.45))
        * smooth(330, 540, t) * oxygen * this.exposure[i] * (1 + Math.abs(wind) * 0.3));
      // 消耗的木质与炭由持续补给补回，外观和可燃库存不会随观看时间耗尽。
      this.fuelConsumed += (pyrolysis * (1 - CHAR_YIELD) + charBurn) * dt / COUNT;
      const hearth = (this.bedTemperature - t) * this.heating[i]
        * (this.bedTemperature > t ? 0.28 : 0.08);
      const cooling = (t - 20) * 0.02 + 12 * (t / 800) ** 4;
      const warmSurface = 95 + (this.initialTemperature[i] - 95) * (0.9 + Math.min(burn, 3) * 0.035);
      const maintenance = Math.max(0, warmSurface - t) * 0.32 * active;
      this.nextTemperature[i] = THREE.MathUtils.clamp(t + dt * (
        conduction + transfer * this.exposure[i] + hearth + charBurn * 30000
        - pyrolysis * 13000 - cooling + maintenance
      ), 20, 1120);
    }
    this.temperature.set(this.nextTemperature);
    this.pack(burn);
  }

  get woodStatistics(): WoodStatistics { return this.statistics; }
  get bedHeat(): number { return smooth(350, 850, this.bedTemperature); }

  /** 仅从正在热解的暴露表面选择火星，冷木柴不会凭空发射碎屑。 */
  pickSparkSource(side: -1 | 0 | 1 = 0): THREE.Vector4 | undefined {
    const eligible = (i: number): boolean => side === 0 || FIRE_SOURCES[i].x * side > 0.18;
    const total = this.sourceActivity.reduce((sum, value, i) => sum + (eligible(i) ? value : 0), 0);
    if (total < 0.01) return undefined;
    let remaining = Math.random() * total;
    for (let i = 0; i < this.sourceActivity.length; i += 1) {
      if (!eligible(i) || this.sourceActivity[i] <= 0) continue;
      remaining -= this.sourceActivity[i];
      if (remaining <= 0) return FIRE_SOURCES[i];
    }
    return undefined;
  }

  dispose(): void { this.texture.dispose(); }

  private cellAt(log: number, u: number, v: number): number {
    return log * CELLS_PER_LOG + Math.min(WOOD_ROWS - 1, Math.floor(v * WOOD_ROWS)) * WOOD_COLUMNS
      + Math.min(WOOD_COLUMNS - 1, Math.floor(u * WOOD_COLUMNS));
  }

  private pyrolysis(i: number, oxygen: number): number {
    return this.virgin[i] * 0.00155
      * Math.exp(THREE.MathUtils.clamp((this.temperature[i] - 330) / 175, -3, 3.1))
      * smooth(250, 380, this.temperature[i]) * oxygen * (1 - this.ash[i] * 0.8)
      * this.ventActivity[i];
  }

  private updateVents(): void {
    // 各个孔隙区域有不同相位/变化速度；双线性插值保持表面与圆周接缝连续。
    for (let log = 0; log < WOOD_SOLIDS.length; log += 1) {
      const base = log * 35;
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 4; x += 1) {
          const seed = this.ventSeed + log * 173.7 + y * 27.31 + x * 8.73;
          const n = smoothNoise(this.elapsed * (0.7 + smoothNoise(seed) * 0.75) + seed);
          const opening = smooth(0.22, 0.78, n);
          this.ventGrid[base + y * 5 + x] = 0.22 + opening * opening * 2.35;
        }
        this.ventGrid[base + y * 5 + 4] = this.ventGrid[base + y * 5];
      }
      for (let v = 0; v < WOOD_ROWS; v += 1) {
        for (let u = 0; u < WOOD_COLUMNS; u += 1) {
          const x = (u + 0.5) / WOOD_COLUMNS * 4, y = (v + 0.5) / WOOD_ROWS * 6;
          const ix = Math.floor(x), iy = Math.floor(y);
          const fx = x - ix, fy = y - iy;
          const p = base + iy * 5 + ix;
          this.ventActivity[log * CELLS_PER_LOG + v * WOOD_COLUMNS + u] = THREE.MathUtils.lerp(
            THREE.MathUtils.lerp(this.ventGrid[p], this.ventGrid[p + 1], fx),
            THREE.MathUtils.lerp(this.ventGrid[p + 5], this.ventGrid[p + 6], fx), fy,
          );
        }
      }
    }
  }

  private pack(burn: number): void {
    const oxygen = smooth(0.0001, 0.03, burn) * burn * 1.65;
    let virgin = 0, mass = 0, char = 0, ash = 0, hot = 0, rate = 0;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < COUNT; i += 1) {
      const flux = this.pyrolysis(i, oxygen);
      this.pixels[i * 4] = this.temperature[i] / 1200;
      this.pixels[i * 4 + 1] = this.converted[i];
      this.pixels[i * 4 + 2] = Math.min(4, flux / FLUX_SCALE);
      this.pixels[i * 4 + 3] = this.ash[i];
      virgin += this.virgin[i];
      mass += this.virgin[i] + this.charFuel[i];
      char += this.converted[i];
      ash += this.ash[i];
      hot += this.temperature[i] > 520 ? 1 : 0;
      rate += flux;
      min = Math.min(min, this.temperature[i]);
      max = Math.max(max, this.temperature[i]);
    }
    this.sourceCells.forEach((cell, i) => {
      this.sourceActivity[i] = this.pixels[cell * 4 + 2] * this.exposure[cell];
    });
    this.statistics = {
      temperatureC: [Math.round(min), Math.round(max)],
      virginFuelRemaining: virgin / this.initialVirgin,
      solidMassLost: Math.max(0, 1 - mass / this.initialMass),
      charCoverage: char / COUNT,
      ashCoverage: ash / COUNT,
      hotSurfaceFraction: hot / COUNT,
      pyrolysisRate: rate / COUNT,
      fuelConsumed: this.fuelConsumed,
    };
    this.texture.needsUpdate = true;
  }
}
