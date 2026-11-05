import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { DEFAULT_CONFIG, type FireSceneConfig, type QualityPreset } from "./types";
import { burnPower } from "./fireIntensity";
import { solidDistance, woodSurface, WOOD_SOLIDS, VOLUME_MIN, VOLUME_SIZE } from "./firePhysics";
import { WOOD_ROWS, type WoodCombustion } from "./woodCombustion";
export { FIRE_SOURCES } from "./firePhysics";
export { smoothNoise } from "./fireNoise";

const GRID = new THREE.Vector3(64, 80, 56);
const COLUMNS = 8;
const READ_GRID = new THREE.Vector3(16, 24, 16);

const QUAD_VERTEX = `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FIELD_COMMON = `
  precision highp float;
  precision highp sampler3D;
  uniform vec3 uGrid;
  uniform vec2 uAtlas;
  uniform vec3 uMin;
  uniform vec3 uSize;
  uniform sampler3D uNoise;
  uniform sampler3D uObstacle;
  uniform sampler3D uWoodSurface;
  uniform sampler2D uWoodState;
  uniform vec3 uFlowSeed;
  const float COLS = 8.0;

  vec4 field(sampler2D atlas, vec3 p) {
    if (any(lessThan(p, vec3(0.0))) || any(greaterThan(p, vec3(1.0)))) return vec4(0.0);
    p = clamp(p, 0.5 / uGrid, 1.0 - 0.5 / uGrid);
    float slice = p.z * uGrid.z - 0.5;
    float z0 = floor(slice);
    float z1 = min(z0 + 1.0, uGrid.z - 1.0);
    vec2 tile0 = vec2(mod(z0, COLS), floor(z0 / COLS));
    vec2 tile1 = vec2(mod(z1, COLS), floor(z1 / COLS));
    vec2 a = (tile0 * uGrid.xy + p.xy * uGrid.xy) / uAtlas;
    vec2 b = (tile1 * uGrid.xy + p.xy * uGrid.xy) / uAtlas;
    return mix(texture(atlas, a), texture(atlas, b), fract(slice));
  }

  vec3 cellPosition() {
    vec2 pixel = floor(gl_FragCoord.xy);
    vec2 tile = floor(pixel / uGrid.xy);
    float z = tile.x + tile.y * COLS;
    return vec3(mod(pixel, uGrid.xy) + 0.5, z + 0.5) / uGrid;
  }

  float noise3(vec3 p) { return texture(uNoise, p / 32.0).r; }
  float fbm(vec3 p) {
    return noise3(p) * 0.57 + noise3(p * 2.03 + 9.7) * 0.28
      + noise3(p * 4.07 - 5.3) * 0.15;
  }

  vec4 obstacle(vec3 p) {
    return texture(uObstacle, clamp(p, vec3(0.0), vec3(1.0)));
  }

  vec4 woodState(vec3 p) {
    return texture(uWoodState, texture(uWoodSurface, p).rg);
  }

  float fuelSource(vec3 p) {
    vec4 surface = texture(uWoodSurface, p);
    float layer = exp(-pow((surface.b - 0.045) / 0.055, 2.0));
    // 只有实际消耗木质的热解表面释放燃料；地面和冷木柴没有独立发射源。
    return layer * woodState(p).b * step(0.008, obstacle(p).a);
  }

  float pressureNeighbor(sampler2D atlas, vec3 p, float center) {
    if (any(lessThan(p, vec3(0.0))) || any(greaterThan(p, vec3(1.0)))) return center;
    return obstacle(p).a < 0.008 ? center : field(atlas, p).r;
  }
`;

const VELOCITY_FRAGMENT = `${FIELD_COMMON}
  uniform sampler2D uVelocity;
  uniform float uDt;
  out vec4 fragColor;
  void main() {
    vec3 p = cellPosition();
    if (obstacle(p).a < 0.008) { fragColor = vec4(0.0); return; }
    // 速度以世界单位保存，沿 X/Y/Z 同时回溯，允许流场保存侧向惯性。
    vec3 previous = field(uVelocity, p).xyz;
    vec3 from = p - previous * uDt / uSize;
    vec3 v = field(uVelocity, from).xyz;
    if (obstacle(from).a < 0.008) v = vec3(0.0);
    fragColor = vec4(v * exp(-uDt * 0.12), 0.0);
  }
`;

const CURL_FRAGMENT = `${FIELD_COMMON}
  uniform sampler2D uVelocity;
  out vec4 fragColor;
  void main() {
    vec3 p = cellPosition();
    if (obstacle(p).a < 0.008) { fragColor = vec4(0.0); return; }
    vec3 h = 1.0 / uGrid;
    vec3 dx = (field(uVelocity, p + vec3(h.x, 0, 0)).xyz
      - field(uVelocity, p - vec3(h.x, 0, 0)).xyz) / (2.0 * uSize.x * h.x);
    vec3 dy = (field(uVelocity, p + vec3(0, h.y, 0)).xyz
      - field(uVelocity, p - vec3(0, h.y, 0)).xyz) / (2.0 * uSize.y * h.y);
    vec3 dz = (field(uVelocity, p + vec3(0, 0, h.z)).xyz
      - field(uVelocity, p - vec3(0, 0, h.z)).xyz) / (2.0 * uSize.z * h.z);
    vec3 curl = vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
    fragColor = vec4(curl, length(curl));
  }
`;

const FORCE_FRAGMENT = `${FIELD_COMMON}
  uniform sampler2D uVelocity;
  uniform sampler2D uState;
  uniform sampler2D uCurl;
  uniform float uTime;
  uniform float uDt;
  uniform float uBurn;
  uniform float uHeight;
  uniform float uTurbulence;
  uniform vec3 uWind;
  out vec4 fragColor;

  vec3 curlNoise(vec3 p) {
    const float e = 0.18;
    vec3 dx = (texture(uNoise, (p + vec3(e,0,0)) / 32.0).rgb
      - texture(uNoise, (p - vec3(e,0,0)) / 32.0).rgb) / (2.0 * e);
    vec3 dy = (texture(uNoise, (p + vec3(0,e,0)) / 32.0).rgb
      - texture(uNoise, (p - vec3(0,e,0)) / 32.0).rgb) / (2.0 * e);
    vec3 dz = (texture(uNoise, (p + vec3(0,0,e)) / 32.0).rgb
      - texture(uNoise, (p - vec3(0,0,e)) / 32.0).rgb) / (2.0 * e);
    return vec3(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
  }

  void main() {
    vec3 p = cellPosition();
    vec4 wall = obstacle(p);
    if (wall.a < 0.008) { fragColor = vec4(0.0); return; }
    vec3 v = field(uVelocity, p).xyz;
    vec4 state = field(uState, p);
    vec3 wp = uMin + p * uSize;
    vec3 h = 1.0 / uGrid;
    vec3 cell = uSize / uGrid;
    vec3 gradient = vec3(
      field(uCurl, p + vec3(h.x, 0, 0)).a - field(uCurl, p - vec3(h.x, 0, 0)).a,
      field(uCurl, p + vec3(0, h.y, 0)).a - field(uCurl, p - vec3(0, h.y, 0)).a,
      field(uCurl, p + vec3(0, 0, h.z)).a - field(uCurl, p - vec3(0, 0, h.z)).a
    ) / (2.0 * cell);
    vec3 omega = field(uCurl, p).xyz;
    vec3 confinement = cross(gradient / max(length(gradient), 0.0001), omega)
      * min(cell.x, min(cell.y, cell.z)) * (3.0 + uTurbulence * 9.0);
    // 浮力是温度产生的加速度，绝不把整个空间重置成向上匀速。
    vec3 acceleration = confinement;
    float vigor = sqrt(max(0.0, uBurn));
    acceleration.y += state.r * (2.6 + uHeight * 1.9) * (0.7 + vigor * 0.5) - state.b * 0.15;
    // 随时间演化的三维旋度场直接作用于热气，而不只给火焰贴图抖动。
    // 大尺度涡旋允许火舌向任意方位卷出；已有压力投影继续保持气体绕流。
    vec3 drift = uFlowSeed + vec3(uTime * 0.53, -uTime * 0.37, uTime * 0.41);
    vec3 eddy = curlNoise(wp * 1.7 + drift);
    float thermal = smoothstep(0.08, 0.5, state.r) * (0.3 + state.r * 0.7);
    acceleration += clamp(eddy, vec3(-1.5), vec3(1.5))
      * thermal * (0.9 + uTurbulence * 4.8) * (0.8 + vigor * 0.35);
    float exposed = smoothstep(0.25, 1.2, wp.y);
    float windSpeed = length(uWind.xz);
    float shelter = mix(0.35, 1.0, smoothstep(0.02, 0.22, wall.a));
    float gust = 1.0 + sin(uTime * 2.1 - wp.y * 1.8) * 0.14
      + (noise3(wp * 1.6 + drift) - 0.5) * 0.2;
    // 放大热羽流的受风响应：中等风力即可侧弯，上部剪切拉长火舌，根部仍受木柴遮挡。
    vec3 wind = uWind * (1.15 + exposed * 0.7) * gust;
    float windCoupling = 0.12 + sqrt(min(windSpeed, 3.5))
      * (0.3 + exposed * 1.15) * shelter;
    acceleration.xz += (wind.xz - v.xz) * windCoupling;
    // 热气比周围冷空气更易被阵风带走，维持清楚的下风侧偏移而不移动燃料源。
    acceleration.xz += uWind.xz * thermal * exposed * shelter * 1.5;
    // 横风不额外压低浮力；阵风带着局部热涡卷向下风侧，停风时附加作用归零。
    acceleration.y -= v.y * (0.12 * 0.08 + windSpeed * 0.04);
    acceleration += clamp(eddy, vec3(-1.5), vec3(1.5))
      * thermal * exposed * min(windSpeed, 3.5) * 0.65;
    float source = fuelSource(p);
    vec3 normal = wall.xyz / max(length(wall.xyz), 0.0001);
    // 热解气体沿真实木柴表面法线逸出，侧面和前后表面均参与燃烧。
    acceleration += normal * source * 4.2;
    vec3 seed = texture(uNoise, (wp * 3.2 + drift * 1.6) / 32.0).rgb - 0.5;
    vec3 tangent = seed - normal * dot(seed, normal);
    acceleration += tangent * source * (1.1 + uTurbulence * 3.2);
    v += clamp(acceleration, vec3(-12.0), vec3(12.0)) * uDt;
    float proximity = 1.0 - smoothstep(0.01, 0.1, wall.a);
    v -= normal * min(dot(v, normal), 0.0) * proximity;
    float speedLimit = 2.4 + vigor * 0.9;
    fragColor = vec4(clamp(v, vec3(-speedLimit), vec3(speedLimit)), 0.0);
  }
`;

const DIVERGENCE_FRAGMENT = `${FIELD_COMMON}
  uniform sampler2D uVelocity;
  uniform sampler2D uState;
  uniform float uTime;
  uniform float uTurbulence;
  out vec4 fragColor;
  void main() {
    vec3 p = cellPosition();
    if (obstacle(p).a < 0.008) { fragColor = vec4(0.0); return; }
    vec3 h = 1.0 / uGrid;
    vec3 cell = uSize / uGrid;
    float divergence =
      (field(uVelocity, p + vec3(h.x, 0, 0)).x - field(uVelocity, p - vec3(h.x, 0, 0)).x) / (2.0 * cell.x) +
      (field(uVelocity, p + vec3(0, h.y, 0)).y - field(uVelocity, p - vec3(0, h.y, 0)).y) / (2.0 * cell.y) +
      (field(uVelocity, p + vec3(0, 0, h.z)).z - field(uVelocity, p - vec3(0, 0, h.z)).z) / (2.0 * cell.z);
    // 允许热气在反应区膨胀，压力推动周围冷空气卷入和侧向流动。
    vec3 wp = uMin + p * uSize;
    float pocket = smoothstep(0.38, 0.68, noise3(wp * 2.3 + uFlowSeed
      + vec3(uTime * 0.71, -uTime * 0.43, uTime * 0.57)));
    divergence -= field(uState, p).a * (0.35 + pocket * 1.1) * (0.6 + uTurbulence * 1.3);
    fragColor = vec4(divergence, 0.0, 0.0, 0.0);
  }
`;

const PRESSURE_FRAGMENT = `${FIELD_COMMON}
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  out vec4 fragColor;
  void main() {
    vec3 p = cellPosition();
    if (obstacle(p).a < 0.008) { fragColor = vec4(0.0); return; }
    vec3 h = 1.0 / uGrid;
    vec3 cell = uSize / uGrid;
    vec3 w = 1.0 / (cell * cell);
    float center = field(uPressure, p).r;
    float sum =
      w.x * (pressureNeighbor(uPressure, p + vec3(h.x, 0, 0), center)
        + pressureNeighbor(uPressure, p - vec3(h.x, 0, 0), center)) +
      w.y * (pressureNeighbor(uPressure, p + vec3(0, h.y, 0), center)
        + pressureNeighbor(uPressure, p - vec3(0, h.y, 0), center)) +
      w.z * (pressureNeighbor(uPressure, p + vec3(0, 0, h.z), center)
        + pressureNeighbor(uPressure, p - vec3(0, 0, h.z), center));
    fragColor = vec4((sum - field(uDivergence, p).r) / (2.0 * (w.x + w.y + w.z)), 0.0, 0.0, 0.0);
  }
`;

const PROJECT_FRAGMENT = `${FIELD_COMMON}
  uniform sampler2D uVelocity;
  uniform sampler2D uPressure;
  uniform float uBurn;
  out vec4 fragColor;
  void main() {
    vec3 p = cellPosition();
    vec4 wall = obstacle(p);
    if (wall.a < 0.008) { fragColor = vec4(0.0); return; }
    vec3 h = 1.0 / uGrid;
    vec3 cell = uSize / uGrid;
    float center = field(uPressure, p).r;
    vec3 gradient = vec3(
      pressureNeighbor(uPressure, p + vec3(h.x, 0, 0), center) - pressureNeighbor(uPressure, p - vec3(h.x, 0, 0), center),
      pressureNeighbor(uPressure, p + vec3(0, h.y, 0), center) - pressureNeighbor(uPressure, p - vec3(0, h.y, 0), center),
      pressureNeighbor(uPressure, p + vec3(0, 0, h.z), center) - pressureNeighbor(uPressure, p - vec3(0, 0, h.z), center)
    ) / (2.0 * cell);
    vec3 v = field(uVelocity, p).xyz - gradient;
    vec3 normal = wall.xyz / max(length(wall.xyz), 0.0001);
    v -= normal * min(dot(v, normal), 0.0) * (1.0 - smoothstep(0.01, 0.09, wall.a));
    float speedLimit = 2.4 + sqrt(max(0.0, uBurn)) * 0.9;
    fragColor = vec4(clamp(v, vec3(-speedLimit), vec3(speedLimit)), 0.0);
  }
`;

const BURN_FRAGMENT = `${FIELD_COMMON}
  uniform sampler2D uVelocity;
  uniform sampler2D uState;
  uniform float uBurn;
  uniform float uDt;
  uniform float uTime;
  uniform float uHeight;
  uniform float uSmoke;
  out vec4 fragColor;
  void main() {
    vec3 p = cellPosition();
    if (obstacle(p).a < 0.008) { fragColor = vec4(0.0); return; }
    vec3 velocity = field(uVelocity, p).xyz;
    vec3 from = p - velocity * uDt / uSize;
    vec4 s = field(uState, from);
    if (obstacle(from).a < 0.008) s = vec4(0.0);
    // R=温度，G=燃料，B=烟尘，A=燃烧反应率；保存上一时刻再平流。
    // 富燃料核心先热解逸出，混入周围空气后才在三维混合边界发生反应。
    // 热气运动卷入空气；高档富燃料区域仍在混合时燃烧，避免饱和后反而变弱。
    float entrainment = 0.1 + min(length(velocity) * 0.04, 0.2);
    float oxygenAvailability = max(entrainment, 1.0 - smoothstep(0.35, 0.98, s.g));
    float reactionDrive = 0.55 + sqrt(max(0.0, uBurn)) * 0.65;
    float consumed = min(s.g, uDt * (1.35 + s.r * 1.35) * reactionDrive)
      * smoothstep(0.12, 0.32, s.r) * oxygenAvailability;
    s.g = max(0.0, s.g - consumed);
    float cooling = 1.35 - uHeight * 0.3 - min(uBurn, 4.5) * 0.14;
    s.r = s.r * exp(-uDt * cooling) + consumed * 0.52;
    s.b = s.b * exp(-uDt * 0.48) + consumed * (0.2 + uSmoke * 0.8);
    s.a = s.a * exp(-uDt * 3.5) + consumed * 2.6;
    float source = fuelSource(p);
    s.g += source * uDt * 8.5;
    // 携带木柴表面显热进入气体，后续反应继续放热。
    s.r += source * uDt * (3.2 + woodState(p).r * 4.5);
    float boundary = smoothstep(0.0, 0.04, p.x) * smoothstep(0.0, 0.04, 1.0 - p.x)
      * smoothstep(0.0, 0.06, p.z) * smoothstep(0.0, 0.06, 1.0 - p.z)
      * smoothstep(0.0, 0.25, 1.0 - p.y);
    fragColor = clamp(s, 0.0, 1.0) * boundary;
  }
`;

// 显示火焰和定位火光共用同一发光函数，热烟不会被误当成投影光源。
const FIRE_EMISSION_COMMON = `
  uniform sampler2D uState;
  uniform sampler2D uVelocity;
  uniform float uTime;
  uniform float uTurbulence;
  uniform float uTone;
  uniform vec3 uFlameColor;
  uniform float uCustomColor;
  uniform float uBurn;

  vec3 blackbody(float heat) {
    vec3 red = vec3(1.0, 0.09, 0.008);
    vec3 orange = vec3(1.0, 0.32, 0.025);
    vec3 yellow = vec3(1.0, 0.76, 0.3);
    vec3 white = vec3(1.0, 0.93, 0.68);
    heat += uTone * 0.1;
    vec3 c = mix(red, orange, smoothstep(0.12, 0.45, heat));
    c = mix(c, yellow, smoothstep(0.42, 0.82, heat));
    return mix(c, white, smoothstep(0.9, 1.14, heat));
  }

  vec3 flameEmission(float heat) {
    // 自定义颜色保留热区的亮暗层次，避免白热混色把绿色、蓝色洗成白色。
    vec3 color = uCustomColor > 0.5
      ? uFlameColor * mix(0.45, 1.0, smoothstep(0.1, 0.9, heat))
      : blackbody(heat);
    return color * (1.6 + heat * heat * 5.4) * (0.85 + uBurn * 0.1);
  }

  vec4 flameSample(vec3 wp) {
    vec3 simulationPosition = (wp - uMin) / uSize;
    float wallDistance = obstacle(simulationPosition).a;
    if (wallDistance < 0.008) return vec4(0.0);
    vec3 velocity = field(uVelocity, simulationPosition).xyz;
    vec3 transported = wp - velocity * 0.13;
    vec3 flow = transported * 4.0 + vec3(uTime * 0.12, -uTime * 0.08, uTime * 0.1);
    vec3 displacement = texture(uNoise, flow / 32.0).rgb - 0.5;
    vec3 warped = wp + displacement * (0.025 + uTurbulence * 0.065)
      * smoothstep(0.3, 1.2, wp.y);
    vec3 p = (warped - uMin) / uSize;
    vec4 s = field(uState, p);
    vec3 q = (warped - velocity * 0.08) * 8.0 + vec3(uTime * 0.21, -uTime * 0.16, uTime * 0.19);
    float detail = fbm(q + displacement * 3.2);
    float temperature = s.r;
    float hot = max(0.0, temperature - 0.13 - (1.0 - detail) * (0.2 + p.y * 0.2));
    // 沿热/冷气体交界生成薄反应层，内部留空。
    float shell = smoothstep(0.018, 0.15, hot) * (1.0 - smoothstep(0.58, 0.92, hot));
    float ridge = exp(-pow((detail - 0.5) / 0.085, 2.0));
    float sheets = mix(smoothstep(0.32, 0.56, detail), ridge, 0.28);
    float reaction = (0.035 + s.a * 1.8) * sheets;
    float quenching = smoothstep(0.005, 0.05, wallDistance);
    float density = 0.65 + sqrt(max(0.0, uBurn)) * 0.35;
    float flame = (shell * 0.5 + hot * 0.055) * reaction * quenching * density;
    float heat = clamp(temperature * 0.78 + s.a * 0.07, 0.0, 1.0);
    return vec4(flame, temperature, heat, s.b);
  }
`;

const VOLUME_FRAGMENT = `${FIELD_COMMON}
  ${FIRE_EMISSION_COMMON}
  in vec2 vUv;
  uniform sampler2D uScene;
  uniform sampler2D uDepth;
  uniform mat4 uInverseProjection;
  uniform mat4 uCameraMatrix;
  uniform vec3 uEye;
  uniform vec2 uResolution;
  uniform float uSmoke;
  uniform vec3 uWind;
  uniform int uSteps;
  out vec4 fragColor;

  vec3 worldPoint(float depth) {
    vec4 view = uInverseProjection * vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return (uCameraMatrix * vec4(view.xyz / view.w, 1.0)).xyz;
  }

  void main() {
    vec3 direction = normalize(worldPoint(1.0) - uEye);
    // 不透明场景深度限制积分距离，火焰正确穿过木柴间隙。
    float opaque = length(worldPoint(texture(uDepth, vUv).r) - uEye);
    vec3 invDir = 1.0 / (direction + vec3(0.000001));
    vec3 a = (uMin - uEye) * invDir;
    vec3 b = (uMin + uSize - uEye) * invDir;
    vec3 nearV = min(a, b);
    vec3 farV = max(a, b);
    float entry = max(0.0, max(nearV.x, max(nearV.y, nearV.z)));
    float finish = min(opaque, min(farV.x, min(farV.y, farV.z)));
    vec3 background = texture(uScene, vUv).rgb;
    if (finish <= entry) {
      fragColor = vec4(background, 1.0);
      return;
    }
    float dt = (finish - entry) / float(uSteps);
    // 固定屏幕抖动消除切片，不使用逐帧白噪声避免闪烁。
    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float distance = entry + dt * jitter;
    float transmittance = 1.0;
    float heatIntegral = 0.0;
    vec3 radiance = vec3(0.0);
    for (int i = 0; i < 128; i++) {
      if (i >= uSteps || distance >= finish || transmittance < 0.025) break;
      vec3 wp = uEye + direction * distance;
      vec3 simulationPosition = (wp - uMin) / uSize;
      if (obstacle(simulationPosition).a < 0.008) { distance += dt; continue; }
      // 亚体素细节由当前三轴速度输运，不再把噪声纹理统一沿 Y 平移。
      vec4 fire = flameSample(wp);
      float temperature = fire.y;
      float soot = fire.w * uSmoke * 0.9 * (1.0 - smoothstep(0.26, 0.66, temperature));
      float fireExtinction = fire.x * 3.2;
      float extinction = fireExtinction + soot * 1.7;
      float absorb = 1.0 - exp(-extinction * dt);
      vec3 emission = flameEmission(fire.z);
      vec3 smokeLight = vec3(0.16, 0.11, 0.075) * exp(-wp.y * 0.45);
      float fireRatio = fireExtinction / max(0.0001, extinction);
      radiance += transmittance * absorb * mix(smokeLight, emission, fireRatio);
      transmittance *= 1.0 - absorb;
      heatIntegral += temperature * dt;
      distance += dt;
    }
    // 只折射穿过热气的背景，偏移限制到亚像素至约两像素。
    vec2 distortion = (texture(uNoise, vec3(vUv * 1.4, uTime * 0.025)).rg - 0.5)
      * min(heatIntegral, 0.65) * 0.003;
    vec3 refracted = texture(uScene, clamp(vUv + distortion, vec2(0.001), vec2(0.999))).rgb;
    fragColor = vec4(radiance + transmittance * refracted, 1.0);
  }
`;

const READBACK_FRAGMENT = `${FIELD_COMMON}
  ${FIRE_EMISSION_COMMON}
  uniform bool uReadLight;
  out vec4 fragColor;
  void main() {
    vec2 pixel = floor(gl_FragCoord.xy);
    vec2 tile = floor(pixel / vec2(16.0, 24.0));
    float z = tile.x + tile.y * 4.0;
    vec3 p = vec3(mod(pixel, vec2(16.0, 24.0)) + 0.5, z + 0.5) / vec3(16.0, 24.0, 16.0);
    if (uReadLight) {
      vec3 wp = uMin + p * uSize;
      vec4 fire = flameSample(wp);
      float weight = fire.x * 3.2 * dot(flameEmission(fire.z), vec3(0.2126, 0.7152, 0.0722));
      fragColor = vec4(wp * weight, weight);
    } else {
      fragColor = vec4(field(uVelocity, p).xyz, field(uState, p).r);
    }
  }
`;

function obstacleTexture(): THREE.Data3DTexture {
  const data = new Uint16Array(GRID.x * GRID.y * GRID.z * 4);
  const p = new THREE.Vector3(), normal = new THREE.Vector3();
  let index = 0;
  for (let z = 0; z < GRID.z; z += 1) {
    for (let y = 0; y < GRID.y; y += 1) {
      for (let x = 0; x < GRID.x; x += 1) {
        p.set(
          VOLUME_MIN.x + (x + 0.5) / GRID.x * VOLUME_SIZE.x,
          VOLUME_MIN.y + (y + 0.5) / GRID.y * VOLUME_SIZE.y,
          VOLUME_MIN.z + (z + 0.5) / GRID.z * VOLUME_SIZE.z,
        );
        const distance = solidDistance(p, normal);
        data[index++] = THREE.DataUtils.toHalfFloat(normal.x);
        data[index++] = THREE.DataUtils.toHalfFloat(normal.y);
        data[index++] = THREE.DataUtils.toHalfFloat(normal.z);
        data[index++] = THREE.DataUtils.toHalfFloat(distance);
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, GRID.x, GRID.y, GRID.z);
  texture.type = THREE.HalfFloatType;
  texture.format = THREE.RGBAFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function woodSurfaceTexture(): THREE.Data3DTexture {
  const data = new Uint16Array(GRID.x * GRID.y * GRID.z * 4);
  const p = new THREE.Vector3(), surface = new THREE.Vector3();
  let index = 0;
  for (let z = 0; z < GRID.z; z += 1) {
    for (let y = 0; y < GRID.y; y += 1) {
      for (let x = 0; x < GRID.x; x += 1) {
        p.set(
          VOLUME_MIN.x + (x + 0.5) / GRID.x * VOLUME_SIZE.x,
          VOLUME_MIN.y + (y + 0.5) / GRID.y * VOLUME_SIZE.y,
          VOLUME_MIN.z + (z + 0.5) / GRID.z * VOLUME_SIZE.z,
        );
        const distance = woodSurface(p, surface);
        const v = (surface.z * WOOD_ROWS + 0.5 + surface.y * (WOOD_ROWS - 1))
          / (WOOD_ROWS * WOOD_SOLIDS.length);
        data[index++] = THREE.DataUtils.toHalfFloat(surface.x);
        data[index++] = THREE.DataUtils.toHalfFloat(v);
        data[index++] = THREE.DataUtils.toHalfFloat(distance);
        data[index++] = 0;
      }
    }
  }
  const texture = new THREE.Data3DTexture(data, GRID.x, GRID.y, GRID.z);
  texture.type = THREE.HalfFloatType;
  texture.format = THREE.RGBAFormat;
  // 禁止在相邻木柴 ID 或圆周 UV 的接缝之间插值。
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

export interface FluidStatistics {
  velocityRms: [number, number, number];
  meanVelocity: [number, number, number];
  hotCentroid: [number, number, number];
  lightCentroid: [number, number, number];
  fireLightPosition: [number, number, number] | null;
  fireLightEmission: number;
  plumeLeanDegrees: number;
  downwardFraction: number;
  outwardFraction: number;
  lateralEnergyFraction: number;
  hotVoxelCount: number;
  hotExtent: [number, number, number];
}

function noiseTexture(): THREE.Data3DTexture {
  const side = 32;
  const bytes = new Uint8Array(side * side * side * 4);
  let state = 419;
  for (let i = 0; i < bytes.length; i += 1) {
    state = Math.imul(state ^ (state >>> 13), 1597334677);
    bytes[i] = (state >>> 24) & 255;
  }
  const texture = new THREE.Data3DTexture(bytes, side, side, side);
  texture.format = THREE.RGBAFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

export class VolumeFire {
  readonly pass: ShaderPass;
  private readonly noise = noiseTexture();
  private readonly obstacles = obstacleTexture();
  private readonly woodSurfaces = woodSurfaceTexture();
  private readonly flowSeed = new THREE.Vector3(Math.random() * 24, Math.random() * 24, Math.random() * 24);
  private readonly atlas = new THREE.Vector2(GRID.x * COLUMNS, GRID.y * GRID.z / COLUMNS);
  private velocity: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private state: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private pressure: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly divergence: THREE.WebGLRenderTarget;
  private readonly curl: THREE.WebGLRenderTarget;
  private readonly readTarget: THREE.WebGLRenderTarget;
  private readonly readMaterial: THREE.ShaderMaterial;
  private readonly flowData = new Float32Array(READ_GRID.x * READ_GRID.y * READ_GRID.z * 4);
  private readonly lightData = new Float32Array(READ_GRID.x * READ_GRID.y * READ_GRID.z * 4);
  private nextRead = 0;
  private statistics: FluidStatistics | null = null;
  private readonly kernels: THREE.ShaderMaterial[];
  private readonly quad = new FullScreenQuad();
  private time = 0;
  private accumulator = 0;
  private quality: QualityPreset = "high";

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    camera: THREE.PerspectiveCamera,
    sceneTarget: THREE.WebGLRenderTarget,
    private readonly wood: WoodCombustion,
  ) {
    if (!renderer.extensions.has("EXT_color_buffer_float")) {
      throw new Error("体积火焰需要支持浮点渲染目标的 WebGL2 浏览器。");
    }
    this.velocity = [this.target(), this.target()];
    this.state = [this.target(), this.target()];
    this.pressure = [this.target(), this.target()];
    this.divergence = this.target();
    this.curl = this.target();
    this.readTarget = new THREE.WebGLRenderTarget(READ_GRID.x * 4, READ_GRID.y * READ_GRID.z / 4, {
      type: THREE.FloatType, depthBuffer: false, stencilBuffer: false,
    });
    this.readMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: QUAD_VERTEX, fragmentShader: READBACK_FRAGMENT,
      depthTest: false, depthWrite: false,
      uniforms: {
        ...this.commonUniforms(), uState: { value: null }, uVelocity: { value: null },
        uReadLight: { value: false }, uTime: { value: 0 }, uTurbulence: { value: 0.5 },
        uBurn: { value: 0 }, uTone: { value: 0 },
        uFlameColor: { value: new THREE.Color(0xffffff) }, uCustomColor: { value: 0 },
      },
    });
    this.kernels = [
      VELOCITY_FRAGMENT, CURL_FRAGMENT, FORCE_FRAGMENT, DIVERGENCE_FRAGMENT,
      PRESSURE_FRAGMENT, PROJECT_FRAGMENT, BURN_FRAGMENT,
    ].map((fragmentShader) => new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERTEX,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...this.commonUniforms(),
        uVelocity: { value: null },
        uState: { value: null },
        uPressure: { value: null },
        uDivergence: { value: this.divergence.texture },
        uCurl: { value: this.curl.texture },
        uTime: { value: 0 },
        uDt: { value: 1 / 30 },
        uBurn: { value: burnPower(DEFAULT_CONFIG.burnIntensity) },
        uHeight: { value: 0.58 },
        uSmoke: { value: 0.2 },
        uWind: { value: new THREE.Vector3() },
        uTurbulence: { value: 0.5 },
      },
    }));
    const material = new THREE.ShaderMaterial({
      name: "BonfireVolumeComposite",
      glslVersion: THREE.GLSL3,
      vertexShader: QUAD_VERTEX,
      fragmentShader: VOLUME_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        ...this.commonUniforms(),
        uScene: { value: sceneTarget.texture },
        uDepth: { value: sceneTarget.depthTexture },
        uState: { value: this.state[0].texture },
        uVelocity: { value: this.velocity[0].texture },
        uInverseProjection: { value: camera.projectionMatrixInverse },
        uCameraMatrix: { value: camera.matrixWorld },
        uEye: { value: camera.position },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uSmoke: { value: 0.2 },
        uWind: { value: new THREE.Vector3() },
        uTurbulence: { value: 0.5 },
        uTone: { value: 0 },
        uFlameColor: { value: new THREE.Color(0xffffff) },
        uCustomColor: { value: 0 },
        uBurn: { value: burnPower(DEFAULT_CONFIG.burnIntensity) },
        uSteps: { value: 112 },
      },
    });
    this.pass = new ShaderPass(material, "unusedInput");
    const prior = renderer.getRenderTarget();
    const color = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0, 0);
    [...this.velocity, ...this.state, ...this.pressure, this.divergence, this.curl].forEach((target) => {
      renderer.setRenderTarget(target);
      renderer.clear();
    });
    renderer.setClearColor(color, alpha);
    renderer.setRenderTarget(prior);
  }

  update(delta: number, config: FireSceneConfig, wind: THREE.Vector3, boost: number): void {
    this.quality = config.quality;
    this.accumulator += Math.min(delta, 0.08);
    // 固定时间步避免慢设备改变燃烧速度；限制追帧数避免卡顿后计算爆发。
    let steps = 0;
    while (this.accumulator >= 1 / 30 && steps < 2) {
      this.simulate(config, wind, boost);
      this.accumulator -= 1 / 30;
      steps += 1;
    }
    if (steps === 2) this.accumulator = Math.min(this.accumulator, 1 / 30);
    this.pass.uniforms.uWind.value.copy(wind);
    this.setAppearance(config, boost);
    if (steps > 0 && this.time >= this.nextRead) {
      this.readFlow();
      this.nextRead = this.time + 0.1;
    }
  }

  /** 颜色等显示参数独立于模拟计时，暂停时也能改色。 */
  setAppearance(config: FireSceneConfig, boost: number): void {
    const uniforms = this.pass.uniforms;
    uniforms.uState.value = this.state[0].texture;
    uniforms.uVelocity.value = this.velocity[0].texture;
    uniforms.uTime.value = this.time;
    uniforms.uSmoke.value = config.smokeDensity / 100;
    uniforms.uTurbulence.value = config.turbulence / 100;
    uniforms.uBurn.value = burnPower(config.burnIntensity, boost);
    uniforms.uTone.value = config.flameTone === "ember" ? -1 : config.flameTone === "white-hot" ? 1 : 0;
    uniforms.uCustomColor.value = config.flameColor ? 1 : 0;
    uniforms.uFlameColor.value.set(config.flameColor ?? 0xffffff);
    uniforms.uSteps.value = config.quality === "high" ? 112 : config.quality === "medium" ? 72 : 48;
  }

  get appearance(): { customColor: string | null; tone: number } {
    const uniforms = this.pass.uniforms;
    return {
      customColor: uniforms.uCustomColor.value ? `#${uniforms.uFlameColor.value.getHexString().toUpperCase()}` : null,
      tone: uniforms.uTone.value,
    };
  }

  get simulationTime(): number {
    return this.time;
  }

  get fluidStatistics(): FluidStatistics | null { return this.statistics; }

  /** 从 GPU 速度场的低分辨率采样缓存做三线性插值，供真实火星动力学使用。 */
  sampleVelocity(position: THREE.Vector3, out: THREE.Vector3): void {
    const x = (position.x - VOLUME_MIN.x) / VOLUME_SIZE.x * READ_GRID.x - 0.5;
    const y = (position.y - VOLUME_MIN.y) / VOLUME_SIZE.y * READ_GRID.y - 0.5;
    const z = (position.z - VOLUME_MIN.z) / VOLUME_SIZE.z * READ_GRID.z - 0.5;
    out.set(0, 0, 0);
    if (x < 0 || y < 0 || z < 0 || x >= READ_GRID.x - 1 || y >= READ_GRID.y - 1 || z >= READ_GRID.z - 1) return;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    for (let dz = 0; dz < 2; dz += 1) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const slice = iz + dz;
          const px = (slice % 4) * READ_GRID.x + ix + dx;
          const py = Math.floor(slice / 4) * READ_GRID.y + iy + dy;
          const index = (py * READ_GRID.x * 4 + px) * 4;
          const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
          out.x += this.flowData[index] * weight;
          out.y += this.flowData[index + 1] * weight;
          out.z += this.flowData[index + 2] * weight;
        }
      }
    }
  }

  /** 同一个 GPU 缓存的温度反馈至木柴，构成固体与热气之间的双向耦合。 */
  sampleTemperature(position: THREE.Vector3): number {
    const x = (position.x - VOLUME_MIN.x) / VOLUME_SIZE.x * READ_GRID.x - 0.5;
    const y = (position.y - VOLUME_MIN.y) / VOLUME_SIZE.y * READ_GRID.y - 0.5;
    const z = (position.z - VOLUME_MIN.z) / VOLUME_SIZE.z * READ_GRID.z - 0.5;
    if (x < 0 || y < 0 || z < 0 || x >= READ_GRID.x - 1 || y >= READ_GRID.y - 1 || z >= READ_GRID.z - 1) return 0;
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    let temperature = 0;
    for (let dz = 0; dz < 2; dz += 1) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const slice = iz + dz;
          const px = (slice % 4) * READ_GRID.x + ix + dx;
          const py = Math.floor(slice / 4) * READ_GRID.y + iy + dy;
          const index = (py * READ_GRID.x * 4 + px) * 4 + 3;
          temperature += this.flowData[index]
            * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        }
      }
    }
    return temperature;
  }

  dispose(): void {
    [...this.velocity, ...this.state, ...this.pressure, this.divergence, this.curl, this.readTarget].forEach((t) => t.dispose());
    this.kernels.forEach((m) => m.dispose());
    this.noise.dispose();
    this.obstacles.dispose();
    this.woodSurfaces.dispose();
    this.readMaterial.dispose();
    this.quad.dispose();
    this.pass.dispose();
  }

  private simulate(config: FireSceneConfig, wind: THREE.Vector3, boost: number): void {
    this.time += 1 / 30;
    this.kernels.forEach((kernel) => {
      kernel.uniforms.uVelocity.value = this.velocity[0].texture;
      kernel.uniforms.uState.value = this.state[0].texture;
      kernel.uniforms.uTime.value = this.time;
      kernel.uniforms.uBurn.value = burnPower(config.burnIntensity, boost);
      kernel.uniforms.uHeight.value = config.flameHeight / 100;
      kernel.uniforms.uSmoke.value = config.smokeDensity / 100;
      kernel.uniforms.uWind.value.copy(wind);
      kernel.uniforms.uTurbulence.value = config.turbulence / 100;
    });
    const prior = this.renderer.getRenderTarget();
    this.run(this.kernels[0], this.velocity[1]);
    this.velocity.reverse();
    this.kernels[1].uniforms.uVelocity.value = this.velocity[0].texture;
    this.run(this.kernels[1], this.curl);
    this.kernels[2].uniforms.uVelocity.value = this.velocity[0].texture;
    this.run(this.kernels[2], this.velocity[1]);
    this.velocity.reverse();
    this.kernels[3].uniforms.uVelocity.value = this.velocity[0].texture;
    this.run(this.kernels[3], this.divergence);
    // 保留上一次压力作为初值。低画质减少 Jacobi 次数，不移除时间连续性。
    const iterations = this.quality === "high" ? 14 : this.quality === "medium" ? 10 : 6;
    for (let i = 0; i < iterations; i += 1) {
      this.kernels[4].uniforms.uPressure.value = this.pressure[0].texture;
      this.run(this.kernels[4], this.pressure[1]);
      this.pressure.reverse();
    }
    this.kernels[5].uniforms.uPressure.value = this.pressure[0].texture;
    this.kernels[5].uniforms.uVelocity.value = this.velocity[0].texture;
    this.run(this.kernels[5], this.velocity[1]);
    this.velocity.reverse();
    this.kernels[6].uniforms.uVelocity.value = this.velocity[0].texture;
    this.run(this.kernels[6], this.state[1]);
    this.state.reverse();
    this.renderer.setRenderTarget(prior);
  }

  private readFlow(): void {
    const prior = this.renderer.getRenderTarget();
    this.readMaterial.uniforms.uVelocity.value = this.velocity[0].texture;
    this.readMaterial.uniforms.uState.value = this.state[0].texture;
    this.readMaterial.uniforms.uReadLight.value = false;
    this.run(this.readMaterial, this.readTarget);
    this.renderer.readRenderTargetPixels(this.readTarget, 0, 0, this.readTarget.width, this.readTarget.height, this.flowData);
    for (const name of ["uTime", "uTurbulence", "uBurn", "uTone", "uCustomColor"]) {
      this.readMaterial.uniforms[name].value = this.pass.uniforms[name].value;
    }
    this.readMaterial.uniforms.uFlameColor.value.copy(this.pass.uniforms.uFlameColor.value);
    this.readMaterial.uniforms.uReadLight.value = true;
    this.run(this.readMaterial, this.readTarget);
    this.renderer.readRenderTargetPixels(this.readTarget, 0, 0, this.readTarget.width, this.readTarget.height, this.lightData);
    this.renderer.setRenderTarget(prior);
    const energy = [0, 0, 0];
    const meanVelocity = [0, 0, 0], centroid = [0, 0, 0];
    const lightCentroid = [0, 0, 0];
    let lightWeight = 0, peakEmission = 0, upperEmission = 0;
    for (let index = 0; index < this.lightData.length; index += 4) {
      const weight = this.lightData[index + 3];
      peakEmission = Math.max(peakEmission, weight);
      if (weight > 1e-6 && this.lightData[index + 1] / weight >= 1.35) {
        upperEmission = Math.max(upperEmission, weight);
      }
    }
    // 上部仍有明亮火舌时取它的光心；矮火只取实际存在的低处发光区域。
    const useUpperFlame = upperEmission >= peakEmission * 0.15 && upperEmission > 1e-6;
    for (let index = 0; index < this.lightData.length; index += 4) {
      const weight = this.lightData[index + 3];
      if (weight < Math.max(1e-6, peakEmission * 0.15)) continue;
      if (useUpperFlame && this.lightData[index + 1] / weight < 1.35) continue;
      lightWeight += weight;
      for (let axis = 0; axis < 3; axis += 1) lightCentroid[axis] += this.lightData[index + axis];
    }
    for (let axis = 0; axis < 3; axis += 1) {
      lightCentroid[axis] = lightWeight > 1e-6 ? lightCentroid[axis] / lightWeight : 0;
    }
    let fireLightPosition: [number, number, number] | null = null;
    let fireLightEmission = 0, nearestDistance = Infinity;
    for (let index = 0; index < this.lightData.length; index += 4) {
      const weight = this.lightData[index + 3];
      if (weight < Math.max(1e-6, peakEmission * 0.15)) continue;
      const point = [0, 1, 2].map(axis => this.lightData[index + axis] / weight) as [number, number, number];
      if (useUpperFlame && point[1] < 1.35) continue;
      const distance = point.reduce((sum, value, axis) => sum + (value - lightCentroid[axis]) ** 2, 0);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        fireLightPosition = point;
        fireLightEmission = weight;
      }
    }
    let plumeWeight = 0, plumeX = 0, plumeY = 0, plumeXY = 0, plumeYY = 0;
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    let hot = 0, down = 0, outward = 0, moving = 0;
    for (let z = 0; z < READ_GRID.z; z += 1) {
      for (let y = 0; y < READ_GRID.y; y += 1) {
        for (let x = 0; x < READ_GRID.x; x += 1) {
          const px = (z % 4) * READ_GRID.x + x;
          const py = Math.floor(z / 4) * READ_GRID.y + y;
          const index = (py * this.readTarget.width + px) * 4;
          if (this.flowData[index + 3] < 0.12) continue;
          hot += 1;
          if (this.flowData[index + 1] < -0.025) down += 1;
          const wx = VOLUME_MIN.x + (x + 0.5) / READ_GRID.x * VOLUME_SIZE.x;
          const wy = VOLUME_MIN.y + (y + 0.5) / READ_GRID.y * VOLUME_SIZE.y;
          const wz = VOLUME_MIN.z + (z + 0.5) / READ_GRID.z * VOLUME_SIZE.z;
          if (wy > 0.65) {
            const weight = this.flowData[index + 3] ** 2;
            plumeWeight += weight;
            plumeX += wx * weight;
            plumeY += wy * weight;
            plumeXY += wx * wy * weight;
            plumeYY += wy * wy * weight;
          }
          if (Math.hypot(wx, wz) > 0.2) {
            moving += 1;
            if (this.flowData[index] * wx + this.flowData[index + 2] * wz > 0.035) outward += 1;
          }
          const cell = [x, y, z];
          for (let axis = 0; axis < 3; axis += 1) {
            energy[axis] += this.flowData[index + axis] ** 2;
            meanVelocity[axis] += this.flowData[index + axis];
            centroid[axis] += VOLUME_MIN.getComponent(axis)
              + (cell[axis] + 0.5) / READ_GRID.getComponent(axis) * VOLUME_SIZE.getComponent(axis);
            minimum[axis] = Math.min(minimum[axis], cell[axis]);
            maximum[axis] = Math.max(maximum[axis], cell[axis]);
          }
        }
      }
    }
    const varianceY = plumeYY - plumeY * plumeY / Math.max(plumeWeight, 1e-6);
    const covarianceXY = plumeXY - plumeX * plumeY / Math.max(plumeWeight, 1e-6);
    this.statistics = {
      velocityRms: energy.map((sum) => Math.sqrt(sum / Math.max(hot, 1))) as [number, number, number],
      meanVelocity: meanVelocity.map(sum => sum / Math.max(hot, 1)) as [number, number, number],
      hotCentroid: centroid.map(sum => hot > 0 ? sum / hot : 0) as [number, number, number],
      lightCentroid: lightCentroid as [number, number, number],
      fireLightPosition, fireLightEmission,
      plumeLeanDegrees: varianceY > 1e-5 ? Math.atan(covarianceXY / varianceY) * 180 / Math.PI : 0,
      downwardFraction: down / Math.max(hot, 1),
      outwardFraction: outward / Math.max(1, moving),
      lateralEnergyFraction: (energy[0] + energy[2]) / Math.max(1e-6, energy[0] + energy[1] + energy[2]),
      hotVoxelCount: hot,
      hotExtent: minimum.map((min, i) => hot > 0
        ? (maximum[i] - min + 1) / READ_GRID.getComponent(i) * VOLUME_SIZE.getComponent(i) : 0) as [number, number, number],
    };
  }

  private run(material: THREE.ShaderMaterial, destination: THREE.WebGLRenderTarget): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(destination);
    this.quad.render(this.renderer);
  }

  private target(): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(this.atlas.x, this.atlas.y, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  private commonUniforms(): Record<string, THREE.IUniform> {
    return {
      uGrid: { value: GRID },
      uAtlas: { value: this.atlas },
      uMin: { value: VOLUME_MIN },
      uSize: { value: VOLUME_SIZE },
      uNoise: { value: this.noise },
      uObstacle: { value: this.obstacles },
      uWoodSurface: { value: this.woodSurfaces },
      uWoodState: { value: this.wood.texture },
      uFlowSeed: { value: this.flowSeed },
    };
  }
}
