import * as THREE from "three";
import { LOG_LAYOUT, woodBendX, woodBendZ, woodEndInset, woodRadius } from "./woodShape";
export { LOG_LAYOUT } from "./woodShape";

export const VOLUME_MIN = new THREE.Vector3(-1.8, 0.02, -1.6);
export const VOLUME_SIZE = new THREE.Vector3(3.6, 4.2, 3.2);

export const WOOD_SOLIDS = LOG_LAYOUT.map(([x, y, z, angle, length, radius], i) => {
  const rotation = new THREE.Euler(0, angle, Math.PI / 2 + (i % 2 ? 0.07 : -0.04));
  return {
    center: new THREE.Vector3(x, y, z),
    axis: new THREE.Vector3(0, 1, 0).applyEuler(rotation),
    radialX: new THREE.Vector3(1, 0, 0).applyEuler(rotation),
    radialZ: new THREE.Vector3(0, 0, 1).applyEuler(rotation),
    length: length * 0.5,
    radius,
  };
});

const solids = WOOD_SOLIDS;

/** 找到烧蚀木柴及其表面 UV；角度沿局部 x/z，轴向从负端到正端。 */
export function woodSurface(p: THREE.Vector3, out: THREE.Vector3): number {
  let nearest = Infinity;
  for (let i = 0; i < solids.length; i += 1) {
    const solid = solids[i];
    const rx = p.x - solid.center.x, ry = p.y - solid.center.y, rz = p.z - solid.center.z;
    const axial = rx * solid.axis.x + ry * solid.axis.y + rz * solid.axis.z;
    const v = axial / (solid.length * 2) + 0.5;
    const x = rx * solid.radialX.x + ry * solid.radialX.y + rz * solid.radialX.z - woodBendX(i, v);
    const z = rx * solid.radialZ.x + ry * solid.radialZ.y + rz * solid.radialZ.z - woodBendZ(i, v);
    const u = (Math.atan2(x, z) / (Math.PI * 2) + 1) % 1;
    const radial = Math.hypot(x, z);
    const radius = woodRadius(i, u, v);
    const dr = radial - radius;
    const da = Math.abs(axial) - solid.length
      + woodEndInset(i, u, axial < 0 ? 0 : 1, radial / radius);
    const distance = Math.hypot(Math.max(dr, 0), Math.max(da, 0)) + Math.min(Math.max(dr, da), 0);
    if (distance >= nearest) continue;
    nearest = distance;
    out.set(
      u,
      THREE.MathUtils.clamp(v, 0, 1),
      i,
    );
  }
  return nearest;
}

/** 烧蚀轮廓的近似符号距离；含缺口和凹端面，正值为气体。 */
export function solidDistance(p: THREE.Vector3, normal?: THREE.Vector3): number {
  let nearest = p.y;
  if (normal) normal.set(0, 1, 0);
  for (let i = 0; i < solids.length; i += 1) {
    const solid = solids[i];
    const rx = p.x - solid.center.x, ry = p.y - solid.center.y, rz = p.z - solid.center.z;
    const axial = rx * solid.axis.x + ry * solid.axis.y + rz * solid.axis.z;
    const v = axial / (solid.length * 2) + 0.5;
    const x = rx * solid.radialX.x + ry * solid.radialX.y + rz * solid.radialX.z - woodBendX(i, v);
    const z = rx * solid.radialZ.x + ry * solid.radialZ.y + rz * solid.radialZ.z - woodBendZ(i, v);
    const radial = Math.hypot(x, z);
    const u = (Math.atan2(x, z) / (Math.PI * 2) + 1) % 1;
    const radius = woodRadius(i, u, v);
    const dr = radial - radius;
    const da = Math.abs(axial) - solid.length
      + woodEndInset(i, u, axial < 0 ? 0 : 1, radial / radius);
    const distance = Math.hypot(Math.max(dr, 0), Math.max(da, 0)) + Math.min(Math.max(dr, da), 0);
    if (distance >= nearest) continue;
    nearest = distance;
    if (normal) {
      if (dr > da || (dr > 0 && da > 0)) {
        const sin = x / Math.max(radial, 1e-6), cos = z / Math.max(radial, 1e-6);
        const du = 1 / 160, dv = 1 / 128;
        const slopeU = (woodRadius(i, u + du, v) - woodRadius(i, u - du, v))
          / (du * 2 * Math.PI * 2 * Math.max(radial, radius * 0.4));
        const slopeV = (woodRadius(i, u, v + dv) - woodRadius(i, u, v - dv))
          / (dv * 4 * solid.length);
        const bendX = (woodBendX(i, v + dv) - woodBendX(i, v - dv)) / (dv * 4 * solid.length);
        const bendZ = (woodBendZ(i, v + dv) - woodBendZ(i, v - dv)) / (dv * 4 * solid.length);
        const nx = sin - cos * slopeU, nz = cos + sin * slopeU;
        normal.copy(solid.radialX).multiplyScalar(nx)
          .addScaledVector(solid.radialZ, nz)
          .addScaledVector(solid.axis, -slopeV - nx * bendX - nz * bendZ).normalize();
        if (dr > 0 && da > 0) {
          normal.multiplyScalar(dr).addScaledVector(solid.axis, Math.sign(axial) * da).normalize();
        }
      } else {
        normal.copy(solid.axis).multiplyScalar(Math.sign(axial) || 1);
      }
    }
  }
  return nearest;
}

// 散布在不同木柴表面的火星发射点；排除被其他木柴遮住的内部位置。
export const FIRE_SOURCES: THREE.Vector4[] = [];
const surfaceNormal = new THREE.Vector3();
for (let i = 0; i < solids.length; i += 1) {
  const solid = solids[i];
  const radial = new THREE.Vector3().crossVectors(solid.axis, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(radial, solid.axis).normalize();
  for (let j = 0; j < 12; j += 1) {
    const angle = (j % 3 - 1) * 0.85;
    const direction = up.clone().multiplyScalar(Math.cos(angle)).addScaledVector(radial, Math.sin(angle));
    const u = Math.atan2(direction.dot(solid.radialX), direction.dot(solid.radialZ)) / (Math.PI * 2);
    const axial = (Math.floor(j / 3) / 3 * 1.16 - 0.58) * solid.length;
    const v = axial / (solid.length * 2) + 0.5;
    const p = solid.center.clone().addScaledVector(solid.axis, axial)
      .addScaledVector(solid.radialX, woodBendX(i, v))
      .addScaledVector(solid.radialZ, woodBendZ(i, v))
      .addScaledVector(direction, woodRadius(i, u, v) + 0.055);
    if (solidDistance(p, surfaceNormal) > 0.005 && p.y > 0.16) {
      FIRE_SOURCES.push(new THREE.Vector4(p.x, p.y, p.z, 0.18));
    }
  }
}
