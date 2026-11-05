import * as THREE from "three";
import { WOOD_ROWS, type WoodCombustion } from "./woodCombustion";
import { WOOD_SOLIDS } from "./firePhysics";
import {
  LOG_LAYOUT, WOOD_SHAPE_COLUMNS, WOOD_SHAPE_ROWS, woodBendX, woodBendZ, woodEndInset, woodRadius,
} from "./woodShape";
import { sampleWoodFracture, type FractureSample } from "./woodFracture";
import { WOOD_VARIATIONS } from "./woodVariation";

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), fx),
    THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), fx),
    fy,
  );
}

function fbm(x: number, y: number): number {
  return noise(x, y) * 0.58 + noise(x * 2.07, y * 2.07) * 0.28
    + noise(x * 4.13, y * 4.13) * 0.14;
}

function smooth(a: number, b: number, value: number): number {
  const x = THREE.MathUtils.clamp((value - a) / (b - a), 0, 1);
  return x * x * (3 - 2 * x);
}

function dataTexture(bytes: Uint8Array<ArrayBuffer>, size: number, color = false): THREE.DataTexture {
  const texture = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function put(bytes: Uint8Array, index: number, r: number, g = r, b = r): void {
  bytes[index] = Math.max(0, Math.min(255, r));
  bytes[index + 1] = Math.max(0, Math.min(255, g));
  bytes[index + 2] = Math.max(0, Math.min(255, b));
  bytes[index + 3] = 255;
}

/** 顺纹沟壑的凹凸、遮蔽与局部余烬；纹理采样实际网格的同一断裂场。 */
export function charredWoodMaterial(log = 0): THREE.MeshStandardMaterial {
  const wood = WOOD_VARIATIONS[log];
  const size = 384;
  const color = new Uint8Array(size * size * 4);
  const height = new Uint8Array(size * size * 4);
  const emission = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  const occlusion = new Uint8Array(size * size * 4);
  const fracture: FractureSample = { depth: 0, cavity: 0, plate: 0, ember: 0 };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size, v = y / size;
      sampleWoodFracture(log, u, v, fracture);
      const a = u * Math.PI * 2;
      const grain = noise(Math.cos(a) * wood.grain + wood.seed * 0.003,
        v * 5 + Math.sin(a) * wood.grain);
      const micro = fbm(u * 160 + log * 17, v * 190);
      const fibres = smooth(0.43, 0.73, grain);
      const value = (47 + grain * 79 + micro * 18) * (1 - fracture.cavity * 0.88);
      const index = (y * size + x) * 4;
      put(color, index, value * 1.22, value * 0.81, value * 0.49);
      const relief = (0.5 + micro * 0.2 + fracture.plate * 0.16
        - fracture.depth * 1.4 - fibres * 0.045) * 255;
      put(height, index, relief);
      // 余烬只在部分沟底/孔洞显露，避免描亮每一个炭块的完整轮廓。
      const glow = fracture.ember * (0.58 + micro * 0.42)
        + smooth(0.62, 0.83, fracture.plate) * (1 - fracture.cavity) * 0.12;
      put(emission, index, glow * 255, glow * 255, glow * 255);
      put(roughness, index, 203 + micro * 48 + fracture.cavity * 18);
      put(occlusion, index, (1 - smooth(0.035, 0.78, fracture.cavity) * 0.94) * 255);
    }
  }
  return new THREE.MeshStandardMaterial({
    map: dataTexture(color, size, true),
    bumpMap: dataTexture(height, size),
    bumpScale: 0.028 * wood.microRelief,
    aoMap: dataTexture(occlusion, size),
    aoMapIntensity: 1.1,
    roughnessMap: dataTexture(roughness, size),
    roughness: 1,
    metalness: 0,
    emissiveMap: dataTexture(emission, size),
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: 2.4,
  });
}

export function woodEndMaterial(log = 0, side = 0): THREE.MeshStandardMaterial {
  const wood = WOOD_VARIATIONS[log];
  const size = 256;
  const color = new Uint8Array(size * size * 4);
  const height = new Uint8Array(size * size * 4);
  const emission = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  const occlusion = new Uint8Array(size * size * 4);
  const fracture: FractureSample = { depth: 0, cavity: 0, plate: 0, ember: 0 };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x / size * 2 - 1, py = y / size * 2 - 1;
      const r = Math.hypot(px, py), u = Math.atan2(px, py) / (Math.PI * 2);
      sampleWoodFracture(log, u, r, fracture, side);
      const n = fbm(px * wood.grain + wood.seed * 0.003, py * wood.grain + side * 17);
      const v = (74 + n * 56 + fracture.plate * 22) * (1 - fracture.cavity * 0.9);
      const i = (y * size + x) * 4;
      put(color, i, v, v * 0.91, v * 0.8);
      put(height, i, (0.48 + n * 0.22 + fracture.plate * 0.17 - fracture.depth * 1.3) * 255);
      const glow = fracture.ember * 0.7 + smooth(0.63, 0.84, fracture.plate) * 0.07;
      put(emission, i, glow * 255, glow * 255, glow * 255);
      put(roughness, i, 225 + n * 28);
      put(occlusion, i, (1 - smooth(0.035, 0.78, fracture.cavity) * 0.94) * 255);
    }
  }
  return new THREE.MeshStandardMaterial({
    map: dataTexture(color, size, true),
    bumpMap: dataTexture(height, size),
    bumpScale: 0.021 * wood.microRelief,
    aoMap: dataTexture(occlusion, size),
    aoMapIntensity: 1.1,
    roughnessMap: dataTexture(roughness, size),
    roughness: 0.97,
    emissiveMap: dataTexture(emission, size),
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: 2,
  });
}

export interface EmberAnimation {
  material: THREE.MeshStandardMaterial;
  time: THREE.IUniform<number>;
  fuel: THREE.IUniform<number>;
  coupled?: boolean;
}

/** 木纹 → 黑炭 → 灰，热红与火焰源采样完全相同的局部状态。 */
export function bindWoodCombustion(
  material: THREE.MeshStandardMaterial, wood: WoodCombustion, log: number,
): EmberAnimation {
  const time = { value: 0 }, fuel = { value: 1 };
  const variation = WOOD_VARIATIONS[log];
  material.emissiveIntensity = 4.2;
  material.onBeforeCompile = (shader) => {
    const uniforms = {
      uWoodState: { value: wood.texture },
      uWoodLog: { value: log },
      uWoodLength: { value: WOOD_SOLIDS[log].length * 2 },
      uWoodTime: time,
      uWoodBend: { value: new THREE.Vector4(variation.bendX, variation.bendZ, variation.sweepX, variation.sweepZ) },
      uWoodCharTint: { value: new THREE.Vector3(...variation.charTint as [number, number, number]) },
      uWoodAshTint: { value: new THREE.Vector3(...variation.ashTint as [number, number, number]) },
    };
    Object.assign(shader.uniforms, uniforms);
    const common = `
      uniform sampler2D uWoodState;
      uniform float uWoodLog;
      uniform float uWoodLength;
      uniform float uWoodTime;
      uniform vec4 uWoodBend;
      uniform vec3 uWoodCharTint;
      uniform vec3 uWoodAshTint;
      varying vec3 vWoodLocal;
      vec2 woodCenter(vec3 p) {
        float t = clamp(p.y / uWoodLength + 0.5, 0.0, 1.0);
        return 4.0 * t * (1.0 - t) * (uWoodBend.xy + uWoodBend.zw * (t - 0.5) * 2.0);
      }
      vec4 woodThermal(vec3 p) {
        vec2 radial = p.xz - woodCenter(p);
        float u = fract(atan(radial.x, radial.y) / 6.2831853 + 1.0);
        float v = clamp(p.y / uWoodLength + 0.5, 0.0, 1.0);
        return texture2D(uWoodState, vec2(u,
          (uWoodLog * ${WOOD_ROWS}.0 + 0.5 + v * ${WOOD_ROWS - 1}.0)
            / ${WOOD_ROWS * WOOD_SOLIDS.length}.0));
      }
    `;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${common}`)
      .replace("#include <begin_vertex>", `
        #include <begin_vertex>
        vWoodLocal = position;
        vec4 woodVertex = woodThermal(position);
        // 烧蚀缺口已进入网格与碰撞轮廓；后续灰化只带来亚体素级退缩。
        vec2 center = woodCenter(position);
        transformed.xz = center + (transformed.xz - center) * (1.0 - woodVertex.a * 0.012);
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${common}`)
      .replace("#include <map_fragment>", `
        #include <map_fragment>
        vec4 wood = woodThermal(vWoodLocal);
        float charred = smoothstep(0.06, 0.65, wood.g);
        float relief = texture2D(bumpMap, vBumpMapUv).r;
        float openness = texture2D(aoMap, vAoMapUv).r;
        vec3 charcoal = vec3(0.007, 0.008, 0.009) * (0.45 + relief * 1.25)
          * (0.2 + openness * 0.8) * uWoodCharTint;
        diffuseColor.rgb = mix(diffuseColor.rgb, charcoal, charred);
        float ashLayer = smoothstep(0.16, 0.6, wood.a) * smoothstep(0.18, 0.78, openness);
        float powder = fract(sin(dot(floor(vWoodLocal * 950.0),
          vec3(127.1, 311.7, 74.7))) * 43758.5453);
        float crust = smoothstep(0.35, 0.72, relief);
        // 灰白的片状外壳与深色孔洞同时可见，细碎粉末增加表面颗粒感。
        vec3 ashColor = mix(vec3(0.13, 0.135, 0.14), vec3(0.62, 0.6, 0.56),
          crust * 0.76 + powder * 0.24);
        diffuseColor.rgb = mix(diffuseColor.rgb, ashColor * uWoodAshTint, ashLayer);
        diffuseColor.rgb *= 0.3 + openness * 0.7;
      `)
      .replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps
        .replace("dHdxy_fwd()", "dHdxy_fwd() * (0.16 + charred * 0.84 + ashLayer * 0.22)"))
      .replace("#include <emissivemap_fragment>", `
        float temperatureC = wood.r * 1200.0;
        float heat = smoothstep(410.0, 880.0, temperatureC);
        // 小尺度明暗变化只调制已有红热区域，冷木质绝不会被噪声点亮。
        vec3 region = floor(vWoodLocal * vec3(25.0, 13.0, 25.0));
        float phase = dot(region, vec3(1.73, 4.19, 2.37)) + uWoodLog * 11.7;
        float flicker = 0.58 + sin(uWoodTime * 1.31 + phase) * 0.24
          + sin(uWoodTime * 2.43 + phase * 1.71) * 0.16;
        vec3 emberColor = mix(vec3(1.0, 0.008, 0.0005), vec3(1.0, 0.13, 0.008),
          smoothstep(0.68, 1.0, heat));
        float mask = texture2D(emissiveMap, vEmissiveMapUv).r;
        totalEmissiveRadiance = emissive * emberColor
          * (mask * 0.9 + 0.012) * heat * heat
          * (0.45 + flicker * 0.9) * charred * (1.0 - ashLayer);
      `);
  };
  material.customProgramCacheKey = () => "wood-thermal-coupling-v4";
  material.needsUpdate = true;
  return { material, time, fuel, coupled: true };
}

/** 每个局部热区独立缓慢闪动，避免整根木柴或所有炭块同步呼吸。 */
export function animateEmbers(material: THREE.MeshStandardMaterial, seed: number): EmberAnimation {
  const time = { value: 0 }, fuel = { value: 0.6 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uEmberTime = time;
    shader.uniforms.uEmberFuel = fuel;
    shader.uniforms.uEmberSeed = { value: seed };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vEmberWorld;")
      .replace("#include <worldpos_vertex>", `
        #include <worldpos_vertex>
        vec4 emberPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          emberPosition = instanceMatrix * emberPosition;
        #endif
        vEmberWorld = (modelMatrix * emberPosition).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `
        #include <common>
        varying vec3 vEmberWorld;
        uniform float uEmberTime;
        uniform float uEmberFuel;
        uniform float uEmberSeed;
        float emberHash(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }
        float emberNoise(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(emberHash(i), emberHash(i + vec3(1,0,0)), f.x),
                mix(emberHash(i + vec3(0,1,0)), emberHash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(emberHash(i + vec3(0,0,1)), emberHash(i + vec3(1,0,1)), f.x),
                mix(emberHash(i + vec3(0,1,1)), emberHash(i + vec3(1,1,1)), f.x), f.y), f.z);
        }
      `)
      .replace("#include <emissivemap_fragment>", `
        #include <emissivemap_fragment>
        #ifdef USE_EMISSIVEMAP
          vec2 emberUv = vEmissiveMapUv;
          float regionPhase = dot(vEmberWorld, vec3(2.1, 3.7, 1.8)) + uEmberSeed;
          float slowHeat = emberNoise(vec3(
            emberUv * vec2(6.0, 9.0) + regionPhase,
            uEmberTime * 0.32 + regionPhase * 0.73));
          float localHeat = emberNoise(vec3(
            emberUv * vec2(17.0, 21.0) - regionPhase,
            uEmberTime * 0.82 + uEmberSeed));
          float heat = smoothstep(0.19, 0.8, slowHeat * 0.8 + localHeat * 0.2);
          float breathe = 0.1 + heat * heat * 1.35;
          vec3 emberColor = mix(vec3(1.0, 0.01, 0.001), vec3(1.0, 0.075, 0.004), heat);
          emberColor = mix(emberColor, vec3(1.0, 0.2, 0.012),
            smoothstep(0.72, 1.0, heat) * (0.25 + uEmberFuel * 0.5));
          float emberMask = texture2D(emissiveMap, emberUv).r;
          totalEmissiveRadiance = emissive * emberMask * emberColor * breathe;
        #endif
      `);
  };
  material.customProgramCacheKey = () => "ember-local-heat-v1";
  material.needsUpdate = true;
  return { material, time, fuel };
}

export function mineralMaterial(soil = false): THREE.MeshStandardMaterial {
  const size = 256;
  const color = new Uint8Array(size * size * 4);
  const height = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size, v = y / size;
      const n = fbm(u * 15, v * 15);
      const grain = noise(u * 115, v * 115);
      const vein = smooth(0.01, 0.12, Math.abs(noise(u * 27, v * 27) - 0.5));
      const value = soil ? 26 + n * 29 + grain * 12 : 62 + n * 63 + grain * 18;
      const i = (y * size + x) * 4;
      put(color, i, value, value * (soil ? 0.85 : 0.97), value * (soil ? 0.68 : 0.95));
      put(height, i, 35 + n * 95 + grain * 80 + vein * 20);
    }
  }
  const map = dataTexture(color, size, true);
  const bump = dataTexture(height, size);
  if (soil) { map.repeat.set(14, 14); bump.repeat.set(14, 14); }
  return new THREE.MeshStandardMaterial({
    map,
    bumpMap: bump,
    bumpScale: soil ? 0.035 : 0.032,
    roughness: 0.95,
    metalness: 0,
  });
}

/** 深纵缝、局部缺块与凹陷破碎端面，和 woodShape 的边界采样一致。 */
export function irregularLogGeometry(log: number): THREE.BufferGeometry {
  const [, , , , length] = LOG_LAYOUT[log];
  const columns = WOOD_SHAPE_COLUMNS, rows = WOOD_SHAPE_ROWS, stride = columns + 1;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const geometry = new THREE.BufferGeometry();
  const seams: Array<[number, number]> = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= columns; column += 1) {
      const u = column / columns, theta = u * Math.PI * 2;
      const bottom = -length / 2 + woodEndInset(log, u, 0);
      const top = length / 2 - woodEndInset(log, u, 1);
      const y = THREE.MathUtils.lerp(bottom, top, row / rows);
      const r = woodRadius(log, u, y / length + 0.5);
      positions.push(woodBendX(log, y / length + 0.5) + Math.sin(theta) * r, y,
        woodBendZ(log, y / length + 0.5) + Math.cos(theta) * r);
      uvs.push(u, y / length + 0.5);
      if (row < rows && column < columns) {
        const a = row * stride + column, b = a + 1, c = a + stride, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    seams.push([row * stride, row * stride + columns]);
  }
  geometry.addGroup(0, indices.length, 0);
  for (let side = 0; side < 2; side += 1) {
    const start = positions.length / 3, groupStart = indices.length, rings = 18;
    for (let ring = 0; ring <= rings; ring += 1) {
      const fraction = ring / rings;
      for (let column = 0; column <= columns; column += 1) {
        const u = column / columns, theta = u * Math.PI * 2;
        const y = (side ? 1 : -1) * (length / 2 - woodEndInset(log, u, side, fraction));
        const r = woodRadius(log, u, y / length + 0.5) * fraction;
        positions.push(woodBendX(log, y / length + 0.5) + Math.sin(theta) * r, y,
          woodBendZ(log, y / length + 0.5) + Math.cos(theta) * r);
        uvs.push(0.5 + Math.sin(theta) * fraction * 0.5, 0.5 + Math.cos(theta) * fraction * 0.5);
        if (ring < rings && column < columns) {
          const a = start + ring * stride + column, b = a + 1, c = a + stride, d = c + 1;
          if (side) indices.push(a, c, b, b, c, d);
          else indices.push(a, b, c, b, d, c);
        }
      }
      seams.push([start + ring * stride, start + ring * stride + columns]);
    }
    geometry.addGroup(groupStart, indices.length - groupStart, side + 1);
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute("normal"), n = new THREE.Vector3();
  for (const [a, b] of seams) {
    n.set(normals.getX(a) + normals.getX(b), normals.getY(a) + normals.getY(b),
      normals.getZ(a) + normals.getZ(b)).normalize();
    normals.setXYZ(a, n.x, n.y, n.z);
    normals.setXYZ(b, n.x, n.y, n.z);
  }
  geometry.computeBoundingSphere();
  return geometry;
}

export function irregularStoneGeometry(seed: number): THREE.SphereGeometry {
  const geometry = new THREE.SphereGeometry(1, 20, 14);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const displacement = 0.9 + Math.sin(x * 5 + seed) * Math.sin(z * 4 - seed) * 0.13
      + Math.sin(y * 8 + z * 5) * 0.045;
    position.setXYZ(i, x * displacement, y * displacement, z * displacement);
  }
  geometry.computeVertexNormals();
  return geometry;
}

export function disposeMaterial(material: THREE.Material): void {
  if (material instanceof THREE.MeshStandardMaterial) {
    const textures = [material.map, material.bumpMap, material.roughnessMap, material.emissiveMap, material.aoMap];
    new Set(textures).forEach((texture) => texture?.dispose());
  }
  material.dispose();
}
