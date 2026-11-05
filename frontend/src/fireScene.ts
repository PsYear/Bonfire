import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import {
  animateEmbers, bindWoodCombustion, charredWoodMaterial, disposeMaterial, irregularLogGeometry,
  irregularStoneGeometry, mineralMaterial, woodEndMaterial, type EmberAnimation,
} from "./fireMaterials";
import { FireSparks } from "./fireSparks";
import { FIRE_SOURCES, smoothNoise, VolumeFire } from "./volumeFire";
import { LOG_LAYOUT } from "./firePhysics";
import { WoodCombustion } from "./woodCombustion";
import { WOOD_VARIATIONS } from "./woodVariation";
import { burnPower } from "./fireIntensity";
import { angleWindDirection, pointerWindDirection, windDirectionAngle, windDirectionInput, windFlow } from "./fireWind";
import { Windmill } from "./windmill";
import { FLAME_TONE_COLORS, type FireSceneConfig, type QualityPreset } from "./types";

const LIGHT_SOURCES = [0, 1, 4];
const FRAMING_POINTS = [-2.75, 2.05].flatMap(x =>
  [0, 3.8].flatMap(y => [-1.65, 1.65].map(z => new THREE.Vector3(x, y, z))));

export class FireScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 1, 0.1, 45);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly sceneTarget: THREE.WebGLRenderTarget;
  private readonly composer: EffectComposer;
  private readonly volume: VolumeFire;
  private readonly wood = new WoodCombustion();
  private readonly sparks = new FireSparks(this.wood);
  private readonly windmill = new Windmill();
  private readonly bloom: UnrealBloomPass;
  private readonly output = new OutputPass();
  private readonly ambient = new THREE.HemisphereLight(0x8594b2, 0x2c170d, 0.25);
  private readonly rim = new THREE.DirectionalLight(0x859bb6, 0.65);
  private readonly bounce = new THREE.PointLight(0xff9d48, 1.5, 5, 2);
  private readonly fireLights: THREE.PointLight[] = [];
  private readonly lightTarget = new THREE.Vector3();
  private readonly emberMaterials: EmberAnimation[] = [];
  private readonly frameObserver: MutationObserver;
  private readonly layoutObserver: ResizeObserver;
  private panelLayoutState = "";
  private readonly sceneSize = new THREE.Vector2();
  private readonly targetSceneSize = new THREE.Vector2();
  private readonly framePoint = new THREE.Vector3();
  private panelPlacement: "right" | "bottom" | "hidden" = "hidden";
  private config: FireSceneConfig;
  private targetConfig: FireSceneConfig;
  private animationId = 0;
  private paused = false;
  private disposed = false;
  private lastTime = performance.now();
  private frameStamp = performance.now();
  private frameCount = 0;
  private renderedFrames = 0;
  private elapsed = 0;
  private readonly pointerWind = new THREE.Vector3(1, 0, 0);
  private readonly pointerTarget = new THREE.Vector3(1, 0, 0);
  private readonly windTarget = new THREE.Vector3(1, 0, 0);
  private readonly currentWind = new THREE.Vector3();
  private pointerPress: { id: number; x: number; y: number; dragged: boolean } | null = null;
  private pointerPosition: { x: number; y: number; id: number } | null = null;
  private readonly pointerDelta = new THREE.Vector2();
  private readonly pointerMovement = new THREE.Vector2();
  private windElapsed = 0;
  private fpsCallback: ((fps: number) => void) | null = null;

  constructor(private readonly host: HTMLElement, config: FireSceneConfig) {
    this.config = { ...config };
    this.targetConfig = { ...config };
    this.pointerTarget.set(...angleWindDirection(config.windAngle));
    this.pointerWind.copy(this.pointerTarget);
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.setPixelRatio(this.pixelRatioFor(config.quality));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute("aria-label", "实时三维体积篝火预览");
    host.appendChild(this.renderer.domElement);
    host.dataset.renderer = "webgl2-volume";
    host.dataset.woodVariations = JSON.stringify(WOOD_VARIATIONS.map((wood) => ({
      kind: wood.kind, seed: wood.seed, length: wood.length, radius: wood.radius,
      crossSection: [wood.ellipseX, wood.ellipseZ, wood.splitDepth],
      bend: [wood.bendX, wood.bendZ], endWear: wood.endWear,
      ashAmount: wood.ashAmount, cracks: [wood.longCracks, wood.crossCracks],
    })));

    this.scene.background = new THREE.Color(0x04070b);
    this.scene.fog = new THREE.FogExp2(0x04070b, 0.048);
    this.camera.position.set(0, 2.6, 7.4);
    this.camera.lookAt(0, 1.05, 0);
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: 4,
    });
    this.sceneTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.composer = new EffectComposer(this.renderer);
    this.volume = new VolumeFire(this.renderer, this.camera, this.sceneTarget, this.wood);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.14, 0.35, 1.3);
    this.composer.addPass(this.volume.pass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.buildEnvironment();
    this.scene.add(this.sparks.mesh, this.windmill.group);
    this.frameObserver = new MutationObserver(this.onPanelLayoutChange);
    this.frameObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    this.layoutObserver = new ResizeObserver(entries => {
      if (entries.some(entry => entry.target === this.host)) this.resize();
      else this.updateLayoutTarget();
    });
    this.layoutObserver.observe(host);
    const panel = document.querySelector<HTMLElement>("#studio-panel");
    if (panel) this.layoutObserver.observe(panel);
    this.resize();
    this.onPanelLayoutChange();
    window.addEventListener("resize", this.resize);
    window.addEventListener("blur", this.resetPointerMovement);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    host.addEventListener("pointermove", this.onPointerMove);
    host.addEventListener("pointerdown", this.onPointerDown);
    host.addEventListener("pointerup", this.onPointerUp);
    host.addEventListener("pointerleave", this.resetPointerMovement);
    host.addEventListener("pointercancel", this.resetPointerMovement);
    host.addEventListener("lostpointercapture", this.resetPointerMovement);
    this.animate();
  }

  setConfig(next: FireSceneConfig): void {
    const qualityChanged = next.quality !== this.targetConfig.quality;
    if (next.windMode !== this.targetConfig.windMode
      || next.interactionMode !== this.targetConfig.interactionMode) this.resetPointerMovement();
    if (next.windMode !== this.targetConfig.windMode
      || next.windDirection !== this.targetConfig.windDirection
      || next.windLeftSeconds !== this.targetConfig.windLeftSeconds
      || next.windRightSeconds !== this.targetConfig.windRightSeconds) this.windElapsed = 0;
    if (next.windAngle !== this.targetConfig.windAngle
      || (next.windMode === "manual" && this.targetConfig.windMode !== "manual")
      || !["cursor-wind", "both"].includes(next.interactionMode)) {
      this.pointerTarget.set(...angleWindDirection(next.windAngle));
    }
    this.targetConfig = { ...next };
    // 爆裂频率与红热亮度直接生效，0% 立即关闭对应效果。
    this.config.sparkBurstFrequency = next.sparkBurstFrequency;
    this.config.charGlowIntensity = next.charGlowIntensity;
    if (next.burnIntensity === 0) this.config.burnIntensity = 0;
    if (next.windSpeed === 0) this.config.windSpeed = 0;
    if (qualityChanged) {
      this.renderer.setPixelRatio(this.pixelRatioFor(next.quality));
      this.setShadowQuality(next.quality);
      this.resize();
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.resetPointerMovement();
    this.lastTime = performance.now();
  }

  setFpsCallback(callback: (fps: number) => void): void {
    this.fpsCallback = callback;
  }

  triggerBoost(): void {
    this.host.dispatchEvent(new Event("fire-boost"));
    this.sparks.burst();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.animationId);
    this.frameObserver.disconnect();
    this.layoutObserver.disconnect();
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("blur", this.resetPointerMovement);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.host.removeEventListener("pointermove", this.onPointerMove);
    this.host.removeEventListener("pointerdown", this.onPointerDown);
    this.host.removeEventListener("pointerup", this.onPointerUp);
    this.host.removeEventListener("pointerleave", this.resetPointerMovement);
    this.host.removeEventListener("pointercancel", this.resetPointerMovement);
    this.host.removeEventListener("lostpointercapture", this.resetPointerMovement);
    this.resetPointerMovement();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry);
        (Array.isArray(object.material) ? object.material : [object.material]).forEach((m) => materials.add(m));
      }
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach(disposeMaterial);
    this.fireLights.forEach((light) => light.dispose());
    this.rim.dispose();
    this.volume.dispose();
    this.wood.dispose();
    this.sparks.dispose();
    this.bloom.dispose();
    this.output.dispose();
    this.composer.dispose();
    this.sceneTarget.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private buildEnvironment(): void {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(32, 32), mineralMaterial(true));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const stoneMaterial = mineralMaterial();
    for (let i = 0; i < 13; i += 1) {
      const angle = i / 13 * Math.PI * 2 + (smoothNoise(i * 18) - 0.5) * 0.08;
      const stone = new THREE.Mesh(irregularStoneGeometry(i * 4.1), stoneMaterial);
      stone.position.set(Math.cos(angle) * 1.76, 0.16, Math.sin(angle) * 1.3);
      stone.scale.set(0.32 + (i % 3) * 0.025, 0.19 + (i % 4) * 0.018, 0.26 + (i % 2) * 0.04);
      stone.rotation.set(i * 0.2, angle, (i % 3 - 1) * 0.16);
      stone.castShadow = stone.receiveShadow = true;
      this.scene.add(stone);
    }

    const bark = charredWoodMaterial();
    LOG_LAYOUT.forEach(([x, y, z, angle], i) => {
      const material = i === 0 ? bark : charredWoodMaterial(i);
      const front = woodEndMaterial(i, 0), back = woodEndMaterial(i, 1);
      this.emberMaterials.push(
        bindWoodCombustion(material, this.wood, i),
        bindWoodCombustion(front, this.wood, i),
        bindWoodCombustion(back, this.wood, i),
      );
      const log = new THREE.Mesh(irregularLogGeometry(i), [material, front, back]);
      log.rotation.set(0, angle, Math.PI / 2 + (i % 2 ? 0.07 : -0.04));
      log.position.set(x, y, z);
      log.castShadow = log.receiveShadow = true;
      this.scene.add(log);
    });

    const coalMaterial = bark.clone();
    coalMaterial.color.set(0x363538);
    coalMaterial.emissiveIntensity = 1.25;
    this.emberMaterials.push(animateEmbers(coalMaterial, 71.53));
    const coalGeometry = irregularStoneGeometry(41);
    const coals = new THREE.InstancedMesh(coalGeometry, coalMaterial, 110);
    const object = new THREE.Object3D();
    for (let i = 0; i < 110; i += 1) {
      const angle = smoothNoise(i * 91.51) * Math.PI * 2;
      const radius = Math.sqrt(smoothNoise(i * 17.14 + 28)) * 1.13;
      object.position.set(Math.cos(angle) * radius, 0.045 + (i % 4) * 0.02, Math.sin(angle) * radius * 0.8);
      const size = 0.03 + smoothNoise(i * 8.27) * 0.065;
      object.scale.set(size, size * 0.65, size * 0.82);
      object.rotation.set(i * 0.12, angle, i * 0.07);
      object.updateMatrix();
      coals.setMatrixAt(i, object.matrix);
    }
    coals.castShadow = coals.receiveShadow = true;
    this.scene.add(coals);

    const debrisMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2824, roughness: 1 });
    const debris = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), debrisMaterial, 160);
    for (let i = 0; i < 160; i += 1) {
      const angle = smoothNoise(i * 38.4) * Math.PI * 2;
      const radius = 0.8 + smoothNoise(i * 11.17) * 2.3;
      object.position.set(Math.cos(angle) * radius, 0.016, Math.sin(angle) * radius * 0.77);
      const size = 0.012 + smoothNoise(i * 93.16) * 0.044;
      object.scale.set(size, size * 0.28, size * 1.6);
      object.rotation.set(0.1, angle, 0.15);
      object.updateMatrix();
      debris.setMatrixAt(i, object.matrix);
    }
    debris.receiveShadow = true;
    this.scene.add(debris);

    // 从已灰化外壳脱落的薄片和粉屑；压扁的轮廓区别于围炉石块。
    const ashMaterial = new THREE.MeshStandardMaterial({ color: 0xb8b5ae, roughness: 1 });
    const ashFlakes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), ashMaterial, 150);
    for (let i = 0; i < 150; i += 1) {
      const angle = smoothNoise(i * 43.73 + 12) * Math.PI * 2;
      const radius = 0.55 + Math.sqrt(smoothNoise(i * 27.17 + 5)) * 0.95;
      object.position.set(Math.cos(angle) * radius, 0.013 + (i % 3) * 0.003,
        Math.sin(angle) * radius * 0.76);
      const size = 0.015 + smoothNoise(i * 9.31 + 18) ** 3 * 0.08;
      object.scale.set(size, 0.004 + size * 0.055, size * (0.65 + smoothNoise(i * 4.29) * 0.9));
      object.rotation.set((i % 5 - 2) * 0.045, angle, (i % 7 - 3) * 0.033);
      object.updateMatrix();
      ashFlakes.setMatrixAt(i, object.matrix);
      ashFlakes.setColorAt(i, new THREE.Color().setScalar(0.52 + smoothNoise(i * 3.47) * 0.42));
    }
    ashFlakes.receiveShadow = true;
    this.scene.add(ashFlakes);

    LIGHT_SOURCES.forEach((sourceIndex, index) => {
      const source = FIRE_SOURCES[sourceIndex];
      const light = new THREE.PointLight(0xffa04c, 12, 9, 2);
      light.position.set(source.x, source.y + 0.7, source.z + 0.18);
      if (index === 0) {
        light.castShadow = true;
        light.shadow.mapSize.setScalar(1024);
        light.shadow.camera.near = 0.05;
        light.shadow.camera.far = 12;
        light.shadow.bias = -0.0003;
        light.shadow.normalBias = 0.002;
        light.shadow.radius = 2;
      }
      this.fireLights.push(light);
      this.scene.add(light);
    });
    this.rim.position.set(-4, 5, -6);
    // 环境轮廓光只补亮，地面的主要投影由篝火中的点光源产生。
    this.rim.castShadow = false;
    this.setShadowQuality(this.config.quality);
    this.bounce.position.set(0.2, 0.75, 1.7);
    this.scene.add(this.ambient, this.rim, this.rim.target, this.bounce);
  }

  private setShadowQuality(quality: QualityPreset): void {
    const light = this.fireLights[0];
    light.shadow.mapSize.setScalar(quality === "high" ? 1536 : quality === "medium" ? 1024 : 768);
    light.shadow.map?.dispose();
    light.shadow.map = null;
    this.host.dataset.shadowQuality = JSON.stringify({
      fire: light.shadow.mapSize.x, environment: 0,
    });
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.animationId = requestAnimationFrame(this.animate);
    const now = performance.now();
    if (document.hidden) { this.lastTime = now; return; }
    const activeDelta = Math.max(0, (now - this.lastTime) / 1000);
    const delta = Math.min(activeDelta, 0.06);
    this.lastTime = now;
    this.updateFraming(delta);
    this.interpolateConfig(delta);
    this.windTarget.copy(this.pointerTarget);
    if (this.targetConfig.windMode !== "manual") {
      this.windTarget.set(windDirectionInput(this.targetConfig, this.windElapsed, 1), 0, 0);
    }
    if (!this.paused) {
      this.elapsed += delta;
      if (this.targetConfig.windMode === "alternating") {
        this.windElapsed += activeDelta;
        this.windTarget.set(windDirectionInput(this.targetConfig, this.windElapsed, 1), 0, 0);
      }
      if (this.targetConfig.windMode === "manual") {
        // 反向时暂时减弱再转向，气体与风车继续保留各自惯性。
        this.pointerWind.lerp(this.windTarget, 1 - Math.exp(-delta * 3));
      } else {
        this.pointerWind.copy(this.windTarget);
      }
      const wind = this.currentWind.copy(this.pointerWind)
        .multiplyScalar(windFlow(this.config.windSpeed, 1, this.elapsed));
      const burn = burnPower(this.config.burnIntensity);
      this.windmill.update(delta, wind, this.elapsed);
      this.wood.update(delta, burn, wind.length(), (position) => this.volume.sampleTemperature(position));
      this.volume.update(delta, this.config, wind, 0);
      this.sparks.update(delta, this.config, (position, velocity) => this.volume.sampleVelocity(position, velocity));
    } else {
      this.volume.setAppearance(this.config, 0);
    }
    // 每帧记录定时风向，避免一秒一次的采样与一秒切换发生混叠。
    this.host.dataset.wind = JSON.stringify({
      strength: this.config.windSpeed, mode: this.targetConfig.windMode,
      direction: this.pointerWind.x, targetDirection: this.windTarget.x,
      directionVector: this.pointerWind.toArray(), targetVector: this.windTarget.toArray(),
      angle: this.targetConfig.windMode === "manual" ? this.targetConfig.windAngle
        : windDirectionAngle(this.windTarget.x, this.windTarget.z),
      flow: this.currentWind.x, flowVector: this.currentWind.toArray(), speed: this.currentWind.length(),
      pointerMovement: this.pointerMovement.toArray(), elapsed: this.windElapsed,
      pointerPressed: this.pointerPress !== null,
      leftSeconds: this.targetConfig.windLeftSeconds, rightSeconds: this.targetConfig.windRightSeconds,
      startDirection: this.targetConfig.windDirection,
    });
    this.updateLighting(delta);
    this.host.dataset.flameAppearance = JSON.stringify({
      ...this.volume.appearance, preset: this.config.flameTone,
      lightColor: `#${this.fireLights[0].color.getHexString().toUpperCase()}`,
    });
    this.camera.updateMatrixWorld();
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.composer.render(delta);
    this.renderedFrames += 1;
    this.frameCount += 1;
    if (now - this.frameStamp >= 1000) {
      this.fpsCallback?.(Math.round(this.frameCount * 1000 / (now - this.frameStamp)));
      this.frameCount = 0;
      this.frameStamp = now;
      // 诊断属性用于测量实际渲染，界面不展示实现细节。
      this.host.dataset.frames = String(this.renderedFrames);
      this.host.dataset.simulationTime = this.volume.simulationTime.toFixed(2);
      this.host.dataset.sparks = String(this.sparks.activeCount);
      this.host.dataset.sparkBursts = JSON.stringify(this.sparks.burstStatistics);
      this.host.dataset.fluidStatistics = JSON.stringify(this.volume.fluidStatistics);
      this.host.dataset.woodStatistics = JSON.stringify(this.wood.woodStatistics);
      this.host.dataset.charGlowIntensity = String(this.config.charGlowIntensity);
      this.host.dataset.burnPower = String(burnPower(this.config.burnIntensity));
      const wheel = this.windmill.statistics;
      this.host.dataset.windmill = JSON.stringify(wheel);
      const light = this.fireLights[0].position;
      const head = wheel.headPosition;
      const scale = light.y / (light.y - head[1]);
      const tailProjection = wheel.tailVertices.map((vertex) => {
        if (light.y <= vertex[1]) return null;
        const distance = light.y / (light.y - vertex[1]);
        return [light.x + (vertex[0] - light.x) * distance, 0,
          light.z + (vertex[2] - light.z) * distance];
      });
      const toScreen = (point: number[] | null) => {
        if (!point) return null;
        const projected = new THREE.Vector3(...point).project(this.camera);
        return [(projected.x + 1) * this.host.clientWidth / 2,
          (1 - projected.y) * this.host.clientHeight / 2];
      };
      this.host.dataset.windmillShadow = JSON.stringify({
        source: "campfire", lightPosition: light.toArray(),
        origin: this.windmill.group.position.toArray(),
        headProjection: light.y > head[1]
          ? [light.x + (head[0] - light.x) * scale, 0, light.z + (head[2] - light.z) * scale] : null,
        environmentCastsShadow: this.rim.castShadow,
        tailVertices: wheel.tailVertices, tailProjection,
        tailScreen: wheel.tailVertices.map(toScreen),
        tailShadowScreen: tailProjection.map(toScreen),
        ...(new URLSearchParams(window.location.search).has("shadow-debug")
          ? { tailDepth: this.readTailShadow(wheel.tailVertices) } : {}),
      });
      this.host.dataset.cameraPose = JSON.stringify([...this.camera.position.toArray(), ...this.camera.quaternion.toArray()]);
    }
  };

  private interpolateConfig(delta: number): void {
    for (const key of Object.keys(this.config) as Array<keyof FireSceneConfig>) {
      const current = this.config[key], target = this.targetConfig[key];
      if (typeof current === "number" && typeof target === "number") {
        (this.config as unknown as Record<string, number>)[key] = THREE.MathUtils.damp(current, target, 3, delta);
      }
    }
    this.config.flameTone = this.targetConfig.flameTone;
    this.config.flameColor = this.targetConfig.flameColor;
    this.config.interactionMode = this.targetConfig.interactionMode;
    this.config.windMode = this.targetConfig.windMode;
    this.config.windDirection = this.targetConfig.windDirection;
    this.config.quality = this.targetConfig.quality;
  }

  /** 可选诊断：读取实际 GPU 阴影深度，核对尾翼的几何遮挡距离。 */
  private readTailShadow(vertices: [number, number, number][]): object[] {
    const light = this.fireLights[0], map = light.shadow.map;
    if (!map) return [];
    const points = vertices.map(vertex => new THREE.Vector3(...vertex));
    return [[0.2, 0.4, 0.4], [0.6, 0.2, 0.2], [0.2, 0.6, 0.2], [0.2, 0.2, 0.6]].map(weights => {
      const point = new THREE.Vector3();
      weights.forEach((weight, index) => point.addScaledVector(points[index], weight));
      const direction = point.clone().sub(light.position).normalize();
      const hit = new THREE.Raycaster(light.position, direction).intersectObject(this.windmill.group, true)[0];
      const absolute = direction.clone().set(Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z));
      const cubeScale = 1 / Math.max(absolute.x, absolute.y, absolute.z);
      absolute.multiplyScalar(cubeScale);
      const texelY = 1 / map.height;
      const v = direction.clone().multiplyScalar(cubeScale * (1 - 2 * texelY));
      let planarX = v.x, planarY = v.y;
      const almostOne = 1 - 1.5 * texelY;
      if (absolute.z >= almostOne) {
        if (v.z > 0) planarX = 4 - v.x;
      } else if (absolute.x >= almostOne) {
        const sign = Math.sign(v.x);
        planarX = v.z * sign + 2 * sign;
      } else if (absolute.y >= almostOne) {
        const sign = Math.sign(v.y);
        planarX = v.x + 2 * sign + 2;
        planarY = v.z * sign - 2;
      }
      const x = Math.floor((planarX * 0.125 + 0.375) * map.width);
      const y = Math.floor((planarY * 0.25 + 0.75) * map.height);
      const pixels = new Uint8Array(5 * 5 * 4);
      this.renderer.readRenderTargetPixels(map, x - 2, y - 2, 5, 5, pixels);
      const expected = point.distanceTo(light.position);
      const near = light.shadow.camera.near, far = light.shadow.camera.far;
      let nearestDepth = Infinity, error = Infinity;
      for (let index = 0; index < pixels.length; index += 4) {
        const packed = pixels[index] / 256 + pixels[index + 1] / 65536
          + pixels[index + 2] / 16777216 + pixels[index + 3] / (255 * 16777216);
        const distance = near + packed * (far - near);
        if (Math.abs(distance - expected) < error) {
          error = Math.abs(distance - expected);
          nearestDepth = distance;
        }
      }
      return {
        point: point.toArray(), occluder: hit?.object.name ?? null,
        tailDistance: expected, gpuDistance: nearestDepth, depthError: error,
        groundDistance: direction.y < 0 ? -light.position.y / direction.y : null,
        shadowRange: far,
      };
    });
  }

  private updateLighting(delta: number): void {
    const burn = burnPower(this.config.burnIntensity);
    const brightness = this.config.fireLight / 100;
    // 50% 对应原来的红热强度，默认 70% 更明显；高端范围保留充足亮度余量。
    const charGlow = (this.config.charGlowIntensity / 50) ** 2;
    const color = new THREE.Color(this.config.flameColor ?? FLAME_TONE_COLORS[this.config.flameTone]);
    const lightCenter = this.volume.fluidStatistics?.fireLightPosition;
    this.fireLights.forEach((light, i) => {
      const activity = this.wood.sourceActivity[LIGHT_SOURCES[i]];
      const illumination = (this.wood.bedHeat * 0.45 + Math.sqrt(burn) * 22 * activity)
        * brightness * (i === 0 ? 0.85 : 0.18);
      const power = 18 * (1 - Math.exp(-illumination / 18));
      light.intensity = THREE.MathUtils.damp(light.intensity, power, 5, delta);
      light.color.lerp(color, 1 - Math.exp(-delta * 3));
      if (!this.paused) {
        const source = FIRE_SOURCES[LIGHT_SOURCES[i]];
        if (i === 0 && lightCenter) {
          // 投影位置来自可见火焰的实际发光样本，不再人为抬高火光。
          this.lightTarget.set(...lightCenter);
        } else if (i === 0) {
          this.lightTarget.set(source.x, source.y + 0.08, source.z);
        } else {
          this.lightTarget.set(source.x + this.currentWind.x * 0.075,
            0.95 + burn * 0.2 + (smoothNoise(this.elapsed * 1.3 + i * 18) - 0.5) * 0.16,
            source.z + 0.18 + this.currentWind.z * 0.075);
        }
        light.position.lerp(this.lightTarget, 1 - Math.exp(-delta * 4));
      }
    });
    const activity = this.wood.sourceActivity.reduce((sum, value) => sum + value, 0)
      / Math.max(1, this.wood.sourceActivity.length);
    const bouncePower = (Math.sqrt(burn) * activity * 4.5 + this.wood.bedHeat * 0.3) * brightness;
    this.bounce.intensity = 4 * (1 - Math.exp(-bouncePower / 4));
    this.bounce.color.lerp(color, 1 - Math.exp(-delta * 3));
    this.ambient.intensity = 0.2 + this.config.environmentLight / 100 * 1.15;
    this.rim.intensity = 0.16 + this.config.environmentLight / 100 * 0.7;
    this.rim.color.setHSL(THREE.MathUtils.lerp(0.61, 0.11, this.config.environmentTemperature / 100), 0.26, 0.65);
    this.emberMaterials.forEach((ember) => {
      ember.time.value = this.elapsed;
      ember.fuel.value = ember.coupled ? burn : this.wood.bedHeat;
      ember.material.emissiveIntensity = (ember.coupled ? 4.2 : this.wood.bedHeat * 3.2) * charGlow;
    });
    this.bloom.strength = 0.11 + Math.min(burn, 2) * 0.035;
    // HDR 场景、体积和火星完成线性合成后统一在 OutputPass 色调映射。
    this.renderer.toneMappingExposure = 1.04;
  }

  private pixelRatioFor(quality: QualityPreset): number {
    const cap = quality === "low" ? 1 : quality === "medium" ? 1.25 : 1.5;
    return Math.min(window.devicePixelRatio, cap);
  }

  private onPanelLayoutChange = (): void => {
    const layout = ["panel-hidden", "immersive", "immersive-reveal"]
      .map(name => document.body.classList.contains(name)).join(":");
    if (layout === this.panelLayoutState) return;
    this.panelLayoutState = layout;
    // 显隐只改变取景目标，不重建渲染缓冲，也不结束正在进行的拖动。
    this.updateLayoutTarget();
  };

  private updateLayoutTarget(): void {
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    const panel = document.querySelector<HTMLElement>("#studio-panel");
    const isOpen = panel && !document.body.classList.contains("panel-hidden")
      && (!document.body.classList.contains("immersive") || document.body.classList.contains("immersive-reveal"));
    let rightSpace = 0, bottomSpace = 0;
    this.panelPlacement = "hidden";
    if (isOpen) {
      const style = getComputedStyle(panel);
      if (window.matchMedia("(max-width: 760px)").matches) {
        bottomSpace = panel.offsetHeight + (parseFloat(style.bottom) || 0) + 12;
        this.panelPlacement = "bottom";
      } else {
        rightSpace = panel.offsetWidth + (parseFloat(style.right) || 0) + 12;
        this.panelPlacement = "right";
      }
    }
    this.targetSceneSize.set(Math.max(1, width - rightSpace), Math.max(1, height - bottomSpace));
    const shell = this.host.parentElement;
    shell?.style.setProperty("--scene-right-space", `${rightSpace}px`);
    shell?.style.setProperty("--scene-bottom-space", `${bottomSpace}px`);
  }

  private updateFraming(delta: number, immediate = false): void {
    const previousX = this.sceneSize.x, previousY = this.sceneSize.y;
    if (immediate || this.sceneSize.distanceTo(this.targetSceneSize) < 0.25) {
      this.sceneSize.copy(this.targetSceneSize);
    } else {
      this.sceneSize.x = THREE.MathUtils.damp(this.sceneSize.x, this.targetSceneSize.x, 14, delta);
      this.sceneSize.y = THREE.MathUtils.damp(this.sceneSize.y, this.targetSceneSize.y, 14, delta);
    }
    if (!immediate && this.sceneSize.x === previousX && this.sceneSize.y === previousY) return;
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    this.camera.clearViewOffset();
    this.camera.aspect = this.sceneSize.x / this.sceneSize.y;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    let extent = 1;
    for (const point of FRAMING_POINTS) {
      this.framePoint.copy(point).project(this.camera);
      extent = Math.max(extent, Math.abs(this.framePoint.x) / 0.9, Math.abs(this.framePoint.y) / 0.9);
    }
    this.camera.zoom = 1 / extent;
    // 以实际可见区域为完整取景，扩展到全画布；光照、火焰与火星共用此投影。
    this.camera.setViewOffset(this.sceneSize.x, this.sceneSize.y, 0, 0, width, height);
    this.camera.updateProjectionMatrix();
    this.framePoint.set(0, 1.05, 0).project(this.camera);
    const min = new THREE.Vector2(Infinity, Infinity), max = new THREE.Vector2(-Infinity, -Infinity);
    for (const point of FRAMING_POINTS) {
      const projected = point.clone().project(this.camera);
      const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * height / 2;
      min.set(Math.min(min.x, x), Math.min(min.y, y));
      max.set(Math.max(max.x, x), Math.max(max.y, y));
    }
    this.host.dataset.sceneLayout = JSON.stringify({
      viewport: [width, height], available: this.sceneSize.toArray(), target: this.targetSceneSize.toArray(),
      placement: this.panelPlacement, zoom: this.camera.zoom,
      center: [(this.framePoint.x + 1) * width / 2, (1 - this.framePoint.y) * height / 2],
      bounds: [min.x, min.y, max.x, max.y],
    });
  }

  private resize = (): void => {
    this.resetPointerMovement();
    const width = Math.max(1, this.host.clientWidth), height = Math.max(1, this.host.clientHeight);
    const mobile = width < 900;
    this.camera.position.set(0, mobile ? 2.9 : 2.6, mobile ? 8.7 : 7.4);
    this.camera.lookAt(0, 1.05, 0);
    this.updateLayoutTarget();
    this.updateFraming(0, true);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    const drawing = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.sceneTarget.setSize(drawing.x, drawing.y);
    this.sparks.resize(drawing.x, drawing.y);
    this.volume.pass.uniforms.uResolution.value.copy(drawing);
  };

  private onPointerMove = (event: PointerEvent): void => {
    const press = this.pointerPress;
    if (this.paused || !event.isPrimary || !press || press.id !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      this.resetPointerMovement();
      return;
    }
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 3) press.dragged = true;
    if (this.targetConfig.windMode !== "manual") return;
    if (!["cursor-wind", "both"].includes(this.targetConfig.interactionMode)) return;
    const previous = this.pointerPosition;
    this.pointerPosition = { x: event.clientX, y: event.clientY, id: event.pointerId };
    if (!previous || previous.id !== event.pointerId) {
      this.pointerDelta.set(0, 0);
      return;
    }
    this.pointerDelta.x += event.clientX - previous.x;
    this.pointerDelta.y += event.clientY - previous.y;
    // 累积微小移动，避免手部抖动改变风向，也不丢失慢速滑动。
    if (this.pointerDelta.length() < 3) return;
    const direction = pointerWindDirection(this.pointerDelta.x, this.pointerDelta.y);
    if (direction) {
      this.pointerTarget.set(...direction);
      const angle = windDirectionAngle(direction[0], direction[2]);
      this.config.windAngle = this.targetConfig.windAngle = angle;
      this.host.dispatchEvent(new CustomEvent("wind-direction-change", { detail: { angle } }));
    }
    this.pointerMovement.copy(this.pointerDelta);
    this.pointerDelta.set(0, 0);
  };

  private resetPointerMovement = (): void => {
    const press = this.pointerPress;
    this.pointerPress = null;
    if (press && this.host.hasPointerCapture(press.id)) this.host.releasePointerCapture(press.id);
    this.host.dataset.dragging = "false";
    // 松开、失焦、暂停或切换控制后结束手势，下一次按下重新建立基线。
    this.pointerPosition = null;
    this.pointerDelta.set(0, 0);
    this.pointerMovement.set(0, 0);
  };

  private onPointerDown = (event: PointerEvent): void => {
    if (this.paused || !event.isPrimary || event.button !== 0) return;
    this.resetPointerMovement();
    this.pointerPress = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
    this.pointerPosition = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.host.setPointerCapture(event.pointerId);
    this.host.dataset.dragging = "true";
    event.preventDefault();
  };

  private onPointerUp = (event: PointerEvent): void => {
    const press = this.pointerPress;
    if (!press || press.id !== event.pointerId || event.button !== 0) return;
    const clicked = !press.dragged && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 3;
    this.resetPointerMovement();
    if (clicked && !this.paused && ["click-boost", "both"].includes(this.targetConfig.interactionMode)) {
      this.triggerBoost();
    }
  };

  private onVisibilityChange = (): void => {
    this.lastTime = performance.now();
    this.resetPointerMovement();
  };
}
