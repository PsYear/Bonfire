import * as THREE from "three";
import { smoothNoise } from "./volumeFire";
import { solidDistance } from "./firePhysics";
import { burnPower } from "./fireIntensity";
import type { WoodCombustion } from "./woodCombustion";
import type { FireSceneConfig } from "./types";

const CAPACITY = 280;

const VERTEX = `
  attribute vec3 aPosition;
  attribute vec3 aPrevious;
  attribute float aHeat;
  attribute float aWidth;
  attribute float aOpacity;
  uniform vec2 uViewport;
  varying vec2 vUv;
  varying float vHeat;
  varying float vOpacity;
  void main() {
    vec4 head = projectionMatrix * modelViewMatrix * vec4(aPosition, 1.0);
    vec4 tail = projectionMatrix * modelViewMatrix * vec4(aPrevious, 1.0);
    vec2 pixelDirection = (head.xy / head.w - tail.xy / tail.w) * uViewport;
    vec2 tangent = length(pixelDirection) > 0.01 ? normalize(pixelDirection) : vec2(0.0, 1.0);
    vec2 perpendicular = vec2(-tangent.y, tangent.x);
    vec4 center = mix(tail, head, uv.y);
    float endCap = (uv.y - 0.5) * aWidth * 0.7;
    center.xy += (perpendicular * position.x * aWidth + tangent * endCap) / uViewport * center.w * 2.0;
    gl_Position = center;
    vUv = uv;
    vHeat = aHeat;
    vOpacity = aOpacity;
  }
`;

const FRAGMENT = `
  varying vec2 vUv;
  varying float vHeat;
  varying float vOpacity;
  void main() {
    float edge = 1.0 - smoothstep(0.12, 0.5, abs(vUv.x - 0.5));
    float tail = smoothstep(0.0, 0.3, vUv.y);
    float tip = 1.0 - smoothstep(0.85, 1.0, vUv.y);
    float alpha = edge * tail * tip * vOpacity;
    vec3 color = mix(vec3(0.55, 0.022, 0.002), vec3(1.0, 0.48, 0.08), vHeat);
    color = mix(color, vec3(1.0, 0.84, 0.4), smoothstep(0.72, 1.0, vHeat));
    gl_FragColor = vec4(color * (0.7 + vHeat * 3.0), alpha);
  }
`;

interface Spark {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  lifetime: number;
  mass: number;
  seed: number;
  heat: number;
  width: number;
}

/** 火星是具有质量和冷却过程的炽热碎屑，不是火焰的替代物。 */
export class FireSparks {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly sparks: Spark[];
  private readonly heads = new Float32Array(CAPACITY * 3);
  private readonly tails = new Float32Array(CAPACITY * 3);
  private readonly heat = new Float32Array(CAPACITY);
  private readonly width = new Float32Array(CAPACITY);
  private readonly opacity = new Float32Array(CAPACITY);
  private emission = 0;
  private cursor = 0;
  private time = 0;
  private activeCapacity = CAPACITY;
  private readonly gasVelocity = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly burstHazard = [0, 0];
  private readonly burstThreshold = [this.nextBurstThreshold(), this.nextBurstThreshold()];
  private readonly sideBurstCounts = [0, 0];
  private readonly sideLaunchSpeed = [0, 0];
  private readonly sideParticleCounts = [0, 0];

  constructor(private readonly wood: WoodCombustion) {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.setAttribute("position", plane.getAttribute("position"));
    this.geometry.setAttribute("uv", plane.getAttribute("uv"));
    this.geometry.setAttribute("aPosition", new THREE.InstancedBufferAttribute(this.heads, 3));
    this.geometry.setAttribute("aPrevious", new THREE.InstancedBufferAttribute(this.tails, 3));
    this.geometry.setAttribute("aHeat", new THREE.InstancedBufferAttribute(this.heat, 1));
    this.geometry.setAttribute("aWidth", new THREE.InstancedBufferAttribute(this.width, 1));
    this.geometry.setAttribute("aOpacity", new THREE.InstancedBufferAttribute(this.opacity, 1));
    this.geometry.instanceCount = CAPACITY;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uViewport: { value: new THREE.Vector2(1, 1) } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.sparks = Array.from({ length: CAPACITY }, (_, i) => ({
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      life: 0,
      lifetime: 1,
      mass: 1,
      seed: i * 71.73,
      heat: 1,
      width: 1,
    }));
  }

  update(
    delta: number,
    config: FireSceneConfig,
    sampleGasVelocity: (position: THREE.Vector3, out: THREE.Vector3) => void,
  ): void {
    this.time += delta;
    const burn = burnPower(config.burnIntensity);
    const rate = config.emberRate / 100;
    this.activeCapacity = config.quality === "low" ? 90 : config.quality === "medium" ? 180 : CAPACITY;
    this.cursor %= this.activeCapacity;
    const sourceHeat = this.wood.sourceActivity.reduce((sum, value) => sum + value, 0)
      / Math.max(1, this.wood.sourceActivity.length);
    const emissionRate = rate * burn * (12 + burn * 33) * Math.min(1.5, sourceHeat * 2);
    this.emission += delta * Math.min(this.activeCapacity * 0.8, emissionRate);
    while (this.emission >= 1) {
      this.spawn(false);
      this.emission -= 1;
    }
    // 左右各有独立的泊松事件时钟，调整频率不会让两边同步或匀速轮流爆裂。
    const burstRate = Math.pow(config.sparkBurstFrequency / 100, 1.55) * 1.6 * Math.sqrt(burn);
    for (let i = 0; i < 2; i += 1) {
      if (burstRate === 0 || sourceHeat < 0.001) {
        this.burstHazard[i] = 0;
        continue;
      }
      this.burstHazard[i] += burstRate * delta;
      let events = 0;
      while (this.burstHazard[i] >= this.burstThreshold[i] && events < 2) {
        this.burstHazard[i] -= this.burstThreshold[i];
        this.burstThreshold[i] = this.nextBurstThreshold();
        this.burst(i === 0 ? -1 : 1);
        events += 1;
      }
    }
    for (let i = 0; i < CAPACITY; i += 1) {
      const particle = this.sparks[i];
      if (particle.life <= 0 || i >= this.activeCapacity) {
        if (i >= this.activeCapacity) particle.life = 0;
        this.opacity[i] = 0;
        continue;
      }
      particle.life -= delta;
      const { position, velocity } = particle;
      sampleGasVelocity(position, this.gasVelocity);
      const drag = 1.25 / particle.mass;
      velocity.x += (this.gasVelocity.x - velocity.x) * drag * delta;
      velocity.z += (this.gasVelocity.z - velocity.z) * drag * delta;
      velocity.y += ((this.gasVelocity.y - velocity.y) * drag - particle.mass * 0.85) * delta;
      position.addScaledVector(velocity, delta);
      const distance = solidDistance(position, this.normal);
      if (distance < 0.004) {
        position.addScaledVector(this.normal, 0.008 - distance);
        const approach = velocity.dot(this.normal);
        if (approach < 0) velocity.addScaledVector(this.normal, -approach * 1.35);
      }
      const lifeRatio = Math.max(0, particle.life / particle.lifetime);
      particle.heat *= Math.exp(-delta * (0.65 / particle.mass));
      const p = i * 3;
      this.heads[p] = position.x;
      this.heads[p + 1] = position.y;
      this.heads[p + 2] = position.z;
      // 约 1/60 秒快门轨迹：细小炽热亮点，不做巨大光球。
      const shutter = 0.012 + particle.mass * 0.009;
      this.tails[p] = position.x - velocity.x * shutter;
      this.tails[p + 1] = position.y - velocity.y * shutter;
      this.tails[p + 2] = position.z - velocity.z * shutter;
      this.heat[i] = particle.heat;
      this.width[i] = particle.width;
      this.opacity[i] = Math.min(1, lifeRatio * 5) * smoothNoise(this.time * 5 + particle.seed) * 0.7;
      if (position.y < 0.08) particle.life = 0;
    }
    ["aPosition", "aPrevious", "aHeat", "aWidth", "aOpacity"].forEach((name) => {
      this.geometry.getAttribute(name).needsUpdate = true;
    });
  }

  burst(side: -1 | 0 | 1 = 0): void {
    const source = this.wood.pickSparkSource(side);
    if (!source) return;
    const count = side === 0 ? 18 : 12 + Math.floor(Math.random() * 12);
    if (side !== 0) this.sideBurstCounts[side < 0 ? 0 : 1] += 1;
    for (let i = 0; i < count; i += 1) this.spawn(true, side, source);
  }

  resize(width: number, height: number): void {
    this.material.uniforms.uViewport.value.set(width, height);
  }

  get activeCount(): number {
    return this.sparks.filter((particle) => particle.life > 0).length;
  }

  get burstStatistics(): { events: number[]; meanLaunchX: number[] } {
    return {
      events: [...this.sideBurstCounts],
      meanLaunchX: this.sideLaunchSpeed.map((sum, i) => sum / Math.max(1, this.sideParticleCounts[i])),
    };
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private spawn(burst: boolean, side: -1 | 0 | 1 = 0, origin?: THREE.Vector4): void {
    const source = origin ?? this.wood.pickSparkSource();
    if (!source) return;
    const particle = this.sparks[this.cursor];
    this.cursor = (this.cursor + 1) % this.activeCapacity;
    particle.position.set(
      source.x + (Math.random() - 0.5) * 0.07,
      source.y + Math.random() * 0.075,
      source.z + (Math.random() - 0.5) * 0.07,
    );
    particle.mass = (side === 0 ? 0.3 : 0.65) + Math.pow(Math.random(), 2) * 0.95;
    particle.velocity.set(
      side === 0 ? (Math.random() - 0.5) * (burst ? 2.1 : 0.5) : side * (1.8 + Math.random() * 2.8),
      0.5 + Math.random() * (side === 0 ? (burst ? 2.8 : 1.1) : 2.0),
      (Math.random() - 0.5) * (side === 0 ? (burst ? 1.5 : 0.45) : 2.2),
    );
    if (side !== 0) {
      const index = side < 0 ? 0 : 1;
      this.sideLaunchSpeed[index] += particle.velocity.x;
      this.sideParticleCounts[index] += 1;
    }
    particle.lifetime = 1.1 + Math.random() * 3.5;
    particle.life = particle.lifetime;
    particle.heat = 0.65 + Math.random() * 0.35;
    particle.width = 0.5 + particle.mass * 0.9;
  }

  private nextBurstThreshold(): number {
    return Math.max(0.04, -Math.log(Math.max(1e-6, 1 - Math.random())));
  }
}
