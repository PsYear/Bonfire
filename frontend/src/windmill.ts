import * as THREE from "three";
import { MAX_WIND_FLOW } from "./fireWind";

export interface WindmillStatistics {
  wind: number;
  windVector: [number, number, number];
  rotationSpeed: number;
  turns: number;
  swayAngle: number;
  facingAngle: number;
  facingDirection: [number, number, number];
  headPosition: [number, number, number];
  tailVertices: [number, number, number][];
}

/** 暖色小风车：转子有惯性，支杆用阻尼弹簧响应实际阵风。 */
export class Windmill {
  readonly group = new THREE.Group();
  private readonly mast = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly rotor = new THREE.Group();
  private readonly tail: THREE.Mesh;
  private speed = 0;
  private turns = 0;
  private readonly wind = new THREE.Vector3();
  private swayX = 0;
  private swayZ = 0;
  private swayVelocityX = 0;
  private swayVelocityZ = 0;
  private readonly worldPosition = new THREE.Vector3();
  private readonly worldRotation = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();

  constructor() {
    this.group.position.set(-2.35, 0, 0.55);
    const stemMaterial = new THREE.MeshStandardMaterial({color: 0x897460, roughness: 0.9});
    const metal = new THREE.MeshStandardMaterial({color: 0xb59368, roughness: 0.5, metalness: 0.55});
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 0.035, 12), stemMaterial);
    foot.position.y = 0.0175;
    this.group.add(foot, this.mast);
    this.mast.position.y = 0.035;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 1.05, 10), stemMaterial);
    stem.position.y = 0.525;
    this.mast.add(stem, this.head);
    this.head.position.y = 1.05;
    this.head.rotation.y = -Math.PI / 2;
    const bearing = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.1, 12), metal);
    bearing.rotation.x = Math.PI / 2;
    this.head.add(bearing, this.rotor);
    this.rotor.position.z = 0.068;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0.018, 0.008, 0.018,
      0.19, 0.022, -0.02,
      0.27, 0.145, -0.005,
      0.11, 0.255, 0.047,
      0.025, 0.065, 0.03,
      0.12, 0.13, 0.055,
    ], 3));
    geometry.setIndex([0, 1, 5, 1, 2, 5, 2, 3, 5, 3, 4, 5, 4, 0, 5]);
    geometry.computeVertexNormals();
    const pale = new THREE.MeshStandardMaterial({color: 0xe6d4b4, roughness: 0.84, side: THREE.DoubleSide});
    const copper = new THREE.MeshStandardMaterial({color: 0xb7855a, roughness: 0.65,
      metalness: 0.16, side: THREE.DoubleSide});
    pale.shadowSide = copper.shadowSide = THREE.DoubleSide;
    for (let i = 0; i < 4; i += 1) {
      const blade = new THREE.Mesh(geometry, i % 2 ? copper : pale);
      blade.rotation.z = i * Math.PI / 2;
      this.rotor.add(blade);
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.038, 12, 8), metal);
    hub.position.z = 0.065;
    this.rotor.add(hub);
    // 尾杆与竖直尾翼位于下风侧，侧视也能读出机头的迎风方向。
    const tailRod = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.4, 8), metal);
    tailRod.rotation.x = Math.PI / 2;
    tailRod.position.z = -0.23;
    const tailGeometry = new THREE.BufferGeometry();
    tailGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0.01, -0.3, 0, 0.14, -0.5, 0, -0.1, -0.5,
    ], 3));
    tailGeometry.setIndex([0, 1, 2]);
    tailGeometry.computeVertexNormals();
    this.tail = new THREE.Mesh(tailGeometry, copper);
    this.tail.name = "windmill-tail";
    this.head.add(tailRod, this.tail);
    this.group.traverse(object => {
      if (object instanceof THREE.Mesh) object.castShadow = object.receiveShadow = true;
    });
  }

  update(delta: number, wind: THREE.Vector3, time: number): void {
    this.wind.copy(wind);
    const speed = Math.hypot(wind.x, wind.z);
    const strength = Math.min(1.2, speed / MAX_WIND_FLOW);
    if (speed > 0.025) {
      // 扇叶前面是局部 +Z；迎风方向必须与气流方向相反，反向时转过 180°。
      const facing = Math.atan2(-wind.x, -wind.z);
      const turn = THREE.MathUtils.euclideanModulo(facing - this.head.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
      this.head.rotation.y += turn * (1 - Math.exp(-delta * 2.5));
    }
    const x = speed > 0 ? wind.x / speed : 0;
    const z = speed > 0 ? wind.z / speed : 0;
    const incidence = -(x * Math.sin(this.head.rotation.y) + z * Math.cos(this.head.rotation.y));
    // 旋向取决于相对机头的受风，不能在机头掉头后仍按世界坐标再次反转。
    const targetSpeed = incidence * 28 * strength ** 0.8;
    const damping = Math.abs(targetSpeed) > Math.abs(this.speed) ? 3.2 : 2.1;
    this.speed = THREE.MathUtils.damp(this.speed, targetSpeed, damping, delta);
    this.turns += this.speed * delta / (Math.PI * 2);
    this.rotor.rotation.z = THREE.MathUtils.euclideanModulo(this.turns * Math.PI * 2, Math.PI * 2);

    const force = strength ** 1.4;
    const targetZ = -x * force * 0.12
      + force * (Math.sin(time * 7.3) * 0.075 + Math.sin(time * 11.7 + 0.8) * 0.025);
    const targetX = z * force * 0.12
      + force * (Math.sin(time * 5.1 + 2.1) * 0.032 + Math.sin(time * 9.4) * 0.012);
    // 子步长保持弹簧在低帧率下稳定，停风后自然收敛，暂停时由场景冻结。
    const steps = Math.max(1, Math.ceil(delta / (1 / 120))), dt = delta / steps;
    for (let i = 0; i < steps; i += 1) {
      this.swayVelocityX += ((targetX - this.swayX) * 64 - this.swayVelocityX * 7) * dt;
      this.swayVelocityZ += ((targetZ - this.swayZ) * 64 - this.swayVelocityZ * 7) * dt;
      this.swayX += this.swayVelocityX * dt;
      this.swayZ += this.swayVelocityZ * dt;
    }
    this.mast.rotation.set(this.swayX, 0, this.swayZ);
  }

  get statistics(): WindmillStatistics {
    this.head.getWorldPosition(this.worldPosition);
    this.head.getWorldQuaternion(this.worldRotation);
    this.axis.set(0, 0, 1).applyQuaternion(this.worldRotation);
    this.tail.updateWorldMatrix(true, false);
    const vertices = this.tail.geometry.getAttribute("position");
    const tailVertices = Array.from({ length: vertices.count }, (_, index) =>
      new THREE.Vector3().fromBufferAttribute(vertices, index).applyMatrix4(this.tail.matrixWorld).toArray());
    return {wind: this.wind.x, windVector: this.wind.toArray(), rotationSpeed: this.speed, turns: this.turns,
      swayAngle: Math.hypot(this.swayX, this.swayZ), facingAngle: this.head.rotation.y,
      facingDirection: this.axis.toArray(), headPosition: this.worldPosition.toArray(), tailVertices};
  }
}
