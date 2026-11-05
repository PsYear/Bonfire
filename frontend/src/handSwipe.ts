export type HandSwipe = "up" | "down";

export interface PalmSample {
  x: number;
  y: number;
  size: number;
  hand: string;
  time: number;
  tipX?: number;
  tipY?: number;
  normalY?: number;
}

export interface HandPoint { x: number; y: number; z?: number }
export interface SwipeProfile {
  normalThreshold: number;
  travelPalmSizes: number;
  minTravel: number;
  minSpeed: number;
  minDurationMs: number;
  windowMs: number;
  cooldownMs: number;
  rearmFraction: number;
}

const DEFAULT_PROFILE: SwipeProfile = {
  normalThreshold: 0.4, travelPalmSizes: 0.6, minTravel: 0.07,
  minSpeed: 0.3, minDurationMs: 140, windowMs: 650, cooldownMs: 550,
  rearmFraction: 0.4,
};
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Both live recognition and sample replay use unmirrored 320×240 coordinates. */
export function handSample(
  points: HandPoint[], world: HandPoint[], hand: string, time: number, confidence = 1,
): PalmSample | null {
  if (points.length !== 21 || !Number.isFinite(confidence) || confidence < 0.6
    || !points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  const average = (indices: number[], axis: "x" | "y"): number =>
    indices.reduce((sum, index) => sum + points[index][axis], 0) / indices.length;
  const distance = (a: number, b: number): number =>
    Math.hypot((points[a].x - points[b].x) * 4 / 3, points[a].y - points[b].y);
  const sample: PalmSample = {
    x: average([0, 5, 9, 13, 17], "x"), y: average([0, 5, 9, 13, 17], "y"),
    tipX: average([8, 12, 16, 20], "x"), tipY: average([8, 12, 16, 20], "y"),
    size: (distance(0, 9) + distance(5, 17)) / 2, hand, time,
  };
  if (world.length === 21 && (hand === "Left" || hand === "Right")
    && world.every(point => [point.x, point.y, point.z].every(Number.isFinite))) {
    const a = { x: world[5].x - world[0].x, y: world[5].y - world[0].y, z: world[5].z! - world[0].z! };
    const b = { x: world[17].x - world[0].x, y: world[17].y - world[0].y, z: world[17].z! - world[0].z! };
    const normal = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
    const length = Math.hypot(normal.x, normal.y, normal.z);
    if (length > 1e-8) sample.normalY = normal.y / length * (hand === "Right" ? 1 : -1);
  }
  return sample;
}

/** Palm-up scoops / palm-down presses, with a separate front-facing swipe fallback. */
export class HandSwipeTracker {
  private readonly profile: SwipeProfile;
  private readonly generic = new VerticalSwipeTracker();
  private raw: PalmSample[] = [];
  private motion: PalmSample[] = [];
  private previous: PalmSample | null = null;
  private cooldownUntil = 0;
  private latch: { direction: HandSwipe; extreme: number; threshold: number; stillSince: number } | null = null;

  constructor(profile: Partial<SwipeProfile> = {}) {
    this.profile = { ...DEFAULT_PROFILE, ...profile };
  }

  reset(): void {
    this.generic.reset();
    this.raw = [];
    this.motion = [];
    this.previous = null;
    this.latch = null;
    this.cooldownUntil = 0;
  }

  update(sample: PalmSample | null): HandSwipe | null {
    if (!sample || ![sample.x, sample.y, sample.size, sample.time].every(Number.isFinite) || sample.size <= 0) {
      this.reset();
      return null;
    }
    const previous = this.previous;
    if (previous && (sample.time <= previous.time || sample.time - previous.time > 300
      || sample.hand !== previous.hand
      || Math.hypot(sample.x - previous.x, sample.y - previous.y) > 0.4
      || sample.size / previous.size > 1.7 || previous.size / sample.size > 1.7)) this.reset();
    this.previous = sample;
    if (![sample.normalY, sample.tipX, sample.tipY].every(Number.isFinite)) {
      this.raw = [];
      this.motion = [];
      this.latch = null;
      return this.updateGeneric(sample);
    }
    this.raw.push(sample);
    this.raw = this.raw.slice(-5);
    if (this.raw.length < 3) return null;
    const recent = this.raw.slice(-3);
    const smooth: PalmSample = {
      ...sample,
      tipX: median(recent.map(point => point.tipX!)),
      tipY: median(recent.map(point => point.tipY!)),
      normalY: median(recent.map(point => point.normalY!)),
    };
    const { normalThreshold, windowMs, cooldownMs, minTravel, travelPalmSizes, rearmFraction } = this.profile;
    const up = this.raw.filter(point => point.normalY! < -normalThreshold).length;
    const down = this.raw.filter(point => point.normalY! > normalThreshold).length;
    const direction: HandSwipe | null = up >= 3 && smooth.normalY! < -normalThreshold ? "up"
      : down >= 3 && smooth.normalY! > normalThreshold ? "down" : null;
    // Only a consistently front-facing palm may use the original vertical swipe rule.
    if (!direction && !this.latch && this.raw.length === 5
      && this.raw.every(point => Math.abs(point.normalY!) < normalThreshold * 0.65)) {
      this.motion = [];
      return this.updateGeneric(sample);
    }
    this.generic.reset();

    if (this.latch) {
      const latch = this.latch;
      const sign = latch.direction === "up" ? -1 : 1;
      const last = this.motion.at(-1);
      if (sign * (smooth.tipY! - latch.extreme) > 0) {
        latch.extreme = smooth.tipY!;
        latch.stillSince = sample.time;
      } else if (last && Math.abs(smooth.tipY! - last.tipY!) > 0.012) {
        latch.stillSince = sample.time;
      }
      const returned = -sign * (smooth.tipY! - latch.extreme) >= latch.threshold * rearmFraction;
      const held = sample.time - latch.stillSince >= 300;
      if (returned || held || (direction && direction !== latch.direction)) {
        this.latch = null;
        this.motion = [smooth];
      } else {
        this.motion = [smooth];
        return null;
      }
    }
    this.motion.push(smooth);
    this.motion = this.motion.filter(point => sample.time - point.time <= windowMs);
    if (!direction || sample.time < this.cooldownUntil || this.motion.length < 3) return null;
    const sign = direction === "up" ? -1 : 1;
    const threshold = Math.max(minTravel, Math.min(0.2, sample.size * travelPalmSizes));
    for (let index = 0; index <= this.motion.length - 3; index++) {
      const start = this.motion[index];
      const duration = sample.time - start.time;
      const travel = sign * (smooth.tipY! - start.tipY!);
      const dx = Math.abs(smooth.tipX! - start.tipX!) * 4 / 3;
      if (duration < this.profile.minDurationMs || travel < threshold || travel < dx * 1.35
        || travel / (duration / 1000) < this.profile.minSpeed) continue;
      const path = this.motion.slice(index);
      if (path.filter(point => sign * point.normalY! > normalThreshold).length < path.length * 0.75) continue;
      let totalTravel = 0;
      for (let step = 1; step < path.length; step++) totalTravel += Math.abs(path[step].tipY! - path[step - 1].tipY!);
      if (travel < totalTravel * 0.75) continue;
      this.cooldownUntil = sample.time + cooldownMs;
      this.latch = { direction, extreme: smooth.tipY!, threshold, stillSince: sample.time };
      this.motion = [smooth];
      return direction;
    }
    return null;
  }

  private updateGeneric(sample: PalmSample): HandSwipe | null {
    if (sample.time < this.cooldownUntil) return null;
    const direction = this.generic.update(sample);
    if (direction) {
      // Switching palm pose after a generic swipe must not trigger a second action.
      this.cooldownUntil = sample.time + 750;
      this.motion = [];
    }
    return direction;
  }
}

/** Generic camera-facing palm swipes retain the brief-hold safety behavior. */
class VerticalSwipeTracker {
  private samples: PalmSample[] = [];
  private previous: PalmSample | null = null;
  private steadyAnchor: PalmSample | null = null;
  private armed = false;
  private cooldownUntil = 0;

  reset(): void {
    this.samples = [];
    this.previous = null;
    this.steadyAnchor = null;
    this.armed = false;
    this.cooldownUntil = 0;
  }

  update(sample: PalmSample | null): HandSwipe | null {
    if (!sample || ![sample.x, sample.y, sample.size, sample.time].every(Number.isFinite)) {
      this.reset();
      return null;
    }
    const previous = this.previous;
    if (previous && (sample.time <= previous.time || sample.time - previous.time > 300
      || sample.hand !== previous.hand
      || Math.hypot(sample.x - previous.x, sample.y - previous.y) > 0.4
      || sample.size / Math.max(previous.size, 0.01) > 1.7
      || previous.size / Math.max(sample.size, 0.01) > 1.7)) {
      this.reset();
    }
    this.previous = sample;

    if (!this.armed) {
      const anchor = this.steadyAnchor;
      const tolerance = Math.max(0.015, Math.min(0.028, sample.size * 0.18));
      if (!anchor || Math.hypot((sample.x - anchor.x) * 4 / 3, sample.y - anchor.y) > tolerance) {
        this.steadyAnchor = sample;
      } else if (sample.time - anchor.time >= 220 && sample.time >= this.cooldownUntil) {
        this.armed = true;
        this.samples = [sample];
      }
      return null;
    }

    this.samples.push(sample);
    this.samples = this.samples.filter((point) => sample.time - point.time <= 650);
    if (this.samples.length < 4) return null;
    const threshold = Math.max(0.12, Math.min(0.22, sample.size * 0.85));
    for (let index = 0; index <= this.samples.length - 4; index++) {
      const start = this.samples[index];
      const duration = sample.time - start.time;
      const dy = sample.y - start.y;
      const dx = (sample.x - start.x) * 4 / 3;
      if (duration < 140 || Math.abs(dy) < threshold
        || Math.abs(dy) < Math.abs(dx) * 1.45 || Math.abs(dy) / (duration / 1000) < 0.35) continue;
      let verticalTravel = 0;
      for (let step = index + 1; step < this.samples.length; step++) {
        verticalTravel += Math.abs(this.samples[step].y - this.samples[step - 1].y);
      }
      if (Math.abs(dy) < verticalTravel * 0.8) continue;
      this.armed = false;
      this.samples = [];
      this.steadyAnchor = null;
      this.cooldownUntil = sample.time + 750;
      return dy < 0 ? "up" : "down";
    }
    return null;
  }
}
