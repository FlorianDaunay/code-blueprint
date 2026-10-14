import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from "three";

/** Shared fog uniforms (linear, by view distance). */
export const fogUniforms = () => ({
  uFogColor: { value: new Color() },
  uFogNear: { value: 100 },
  uFogFar: { value: 1000 },
});

/**
 * Instanced "hologram block": vertical gradient, simple key light, glowing world-space edges.
 * Per instance: colour (instanceColor), aState (0 normal, 1 dimmed, 2 highlighted, 3 selected), aPulse.
 * Geometry must be a unit box with its base at y = 0.
 */
export function blockMaterial(opts: { edge: number; fill: number; glow: number }): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uEdge: { value: opts.edge },
      uFill: { value: opts.fill },
      uGlow: { value: opts.glow },
      uDim: { value: new Color("#151a22") },
      ...fogUniforms(),
    },
    vertexShader: /* glsl */ `
      attribute float aState;
      attribute float aPulse;
      varying vec3 vColor;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vNormal;
      varying float vState;
      varying float vPulse;
      varying float vDepth;
      void main() {
        mat4 m = instanceMatrix;
        vec4 world = modelMatrix * m * vec4(position, 1.0);
        vLocal = position;
        vScale = vec3(length(m[0].xyz), length(m[1].xyz), length(m[2].xyz));
        vNormal = normalize(mat3(modelMatrix) * mat3(m) * normal);
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3(1.0);
        #endif
        vState = aState;
        vPulse = aPulse;
        vec4 view = viewMatrix * world;
        vDepth = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uEdge;
      uniform float uFill;
      uniform float uGlow;
      uniform vec3 uDim;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vColor;
      varying vec3 vLocal;
      varying vec3 vScale;
      varying vec3 vNormal;
      varying float vState;
      varying float vPulse;
      varying float vDepth;
      void main() {
        // Distance (world units) to the two nearest faces: the second one tells how close we are to an edge.
        vec3 d = (0.5 - abs(vLocal - vec3(0.0, 0.5, 0.0))) * vScale;
        float mn = min(d.x, min(d.y, d.z));
        float mx = max(d.x, max(d.y, d.z));
        float mid = d.x + d.y + d.z - mn - mx;
        float edge = 1.0 - smoothstep(uEdge * 0.35, uEdge, mid);
        float h = clamp(vLocal.y, 0.0, 1.0);
        float light = 0.55 + 0.45 * max(dot(vNormal, normalize(vec3(0.45, 0.85, 0.3))), 0.0);
        float top = step(0.5, vNormal.y);
        vec3 col = vColor * (uFill * (0.35 + 0.65 * h) * light + top * 0.18) + vColor * edge * uGlow;
        float pulse = vPulse * (0.5 + 0.5 * sin(uTime * 5.0));
        col += vColor * pulse * 0.9;
        if (vState > 0.5 && vState < 1.5) {
          col = mix(uDim, uDim + vColor * 0.08, edge);
        } else if (vState > 1.5 && vState < 2.5) {
          col = col * 1.25 + vColor * edge * 0.6;
        } else if (vState > 2.5) {
          float beat = 0.6 + 0.4 * sin(uTime * 3.0);
          col = col * 1.4 + vec3(1.0) * edge * beat;
        }
        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
      }
    `,
  });
}

/** Infinite-looking ground grid that fades with distance. */
export function gridMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uColor: { value: new Color() },
      uMajor: { value: new Color() },
      uCell: { value: 2 },
      uRadius: { value: 200 },
      ...fogUniforms(),
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 view = viewMatrix * world;
        vDepth = -view.z;
        gl_Position = projectionMatrix * view;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform vec3 uMajor;
      uniform float uCell;
      uniform float uRadius;
      uniform vec3 uFogColor;
      uniform float uFogNear;
      uniform float uFogFar;
      varying vec3 vWorld;
      varying float vDepth;
      float line(vec2 p, float cell) {
        vec2 g = abs(fract(p / cell - 0.5) - 0.5) / fwidth(p / cell);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = line(vWorld.xz, uCell);
        float major = line(vWorld.xz, uCell * 10.0);
        float fade = 1.0 - smoothstep(uRadius * 0.4, uRadius, length(vWorld.xz));
        vec3 col = mix(uColor, uMajor, major);
        float a = max(minor * 0.35, major * 0.8) * fade;
        float fog = smoothstep(uFogNear, uFogFar, vDepth);
        if (a < 0.01) discard;
        gl_FragColor = vec4(mix(col, uFogColor, fog), a * (1.0 - fog));
      }
    `,
  });
}

/** Dependency arcs: additive lines with pulses travelling from source (t=0) to target (t=1). */
export function arcMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uFlow: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aT;
      attribute vec3 aColor;
      attribute float aAlpha;
      varying float vT;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vT = aT;
        vColor = aColor;
        vAlpha = aAlpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uFlow;
      varying float vT;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        float pulse = pow(fract(vT * 2.0 - uTime * 0.6), 6.0);
        float ends = smoothstep(0.0, 0.04, vT) * smoothstep(1.0, 0.92, vT);
        float a = vAlpha * (0.35 + uFlow * 1.6 * pulse) * (0.4 + 0.6 * ends);
        gl_FragColor = vec4(vColor * a, a);
      }
    `,
  });
}
