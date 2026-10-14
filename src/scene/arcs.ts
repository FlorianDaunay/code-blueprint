import { BufferAttribute, BufferGeometry, Color, LineSegments, Vector3 } from "three";
import { arcMaterial } from "./materials";

export interface Arc {
  from: Vector3;
  to: Vector3;
  color: Color;
  alpha: number;
}

const SEGMENTS = 28;

/** All arcs of a frame in one LineSegments draw call (quadratic Béziers lifted above the city). */
export class ArcLayer {
  readonly object: LineSegments;
  private material = arcMaterial();

  constructor() {
    this.object = new LineSegments(new BufferGeometry(), this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
  }

  set(arcs: Arc[], lift: number) {
    const n = arcs.length * SEGMENTS * 2;
    const pos = new Float32Array(n * 3);
    const t = new Float32Array(n);
    const col = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const p = new Vector3();
    const ctrl = new Vector3();
    let k = 0;
    const point = (a: Arc, u: number, out: Vector3) => {
      // B(u) = (1-u)² A + 2u(1-u) C + u² B
      const iu = 1 - u;
      out.set(0, 0, 0).addScaledVector(a.from, iu * iu).addScaledVector(ctrl, 2 * u * iu).addScaledVector(a.to, u * u);
      return out;
    };
    for (const a of arcs) {
      const dist = a.from.distanceTo(a.to);
      ctrl.copy(a.from).add(a.to).multiplyScalar(0.5);
      ctrl.y = Math.max(a.from.y, a.to.y) + lift + dist * 0.45;
      for (let s = 0; s < SEGMENTS; s++) {
        for (const u of [s / SEGMENTS, (s + 1) / SEGMENTS]) {
          point(a, u, p);
          pos[k * 3] = p.x;
          pos[k * 3 + 1] = p.y;
          pos[k * 3 + 2] = p.z;
          t[k] = u;
          col[k * 3] = a.color.r;
          col[k * 3 + 1] = a.color.g;
          col[k * 3 + 2] = a.color.b;
          alpha[k] = a.alpha;
          k++;
        }
      }
    }
    const g = this.object.geometry;
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aT", new BufferAttribute(t, 1));
    g.setAttribute("aColor", new BufferAttribute(col, 3));
    g.setAttribute("aAlpha", new BufferAttribute(alpha, 1));
    g.computeBoundingSphere();
    this.object.visible = arcs.length > 0;
  }

  tick(time: number) {
    this.material.uniforms.uTime.value = time;
  }

  setFlow(on: boolean) {
    this.material.uniforms.uFlow.value = on ? 1 : 0;
  }
}
