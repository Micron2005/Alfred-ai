"use client";

/**
 * HolographicEarth — JARVIS-style 3D globe with real Earth surface.
 *
 * Aesthetic: a textured Earth (NASA Blue Marble — public domain via
 * the three.js examples server) tinted cyan with a hologram shader:
 *   - cyan colour multiply on top of the surface texture
 *   - fresnel rim glow at the silhouette
 *   - subtle scanlines so it reads as a hologram, not a globe model
 * Plus a faint atmosphere halo, slow auto-rotation, and a starfield.
 *
 * Interaction:
 *   - Drag to rotate (OrbitControls).
 *   - Scroll / pinch to zoom.
 *   - Click to pick a lat/lon — the parent transitions to a
 *     full-screen detail view.
 *
 * Lazy-loaded by ``EarthHologramWidget`` (React.lazy) because
 * react-three-fiber pulls in three.js (~600 KB minified).
 */

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";

interface Props {
  /** Called when the user clicks a point on the globe. ``lat`` is
   *  -90..90, ``lon`` is -180..180, both in degrees. */
  onPick?: (coords: { lat: number; lon: number }) => void;
  /** Inline width/height override. Globe fills its container by
   *  default. */
  height?: number | string;
  /** Whether the globe gently auto-rotates when idle. Default true. */
  autoRotate?: boolean;
}

const RADIUS = 1;
const HOLO_COLOUR = "#6cd6ff";

// NASA Blue Marble equirectangular projection, hosted by the
// three.js project (CC-BY / public domain image, stable URL used
// in their official examples). 2048×1024 — small enough to fetch
// fast over LTE, large enough that continents read at any zoom.
const EARTH_TEXTURE_URL =
  "https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg";

export function HolographicEarth({
  onPick,
  height = 360,
  autoRotate = true,
}: Props) {
  return (
    <div
      data-testid="holographic-earth"
      style={{
        position: "relative",
        width: "100%",
        height,
        // Frame-less — the globe floats like Alfred's main orb.
        // No border / background panel.
        overflow: "hidden",
        background: "transparent",
      }}
    >
      <Canvas
        camera={{ position: [0, 0.6, 3.2], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.55} />
        <pointLight position={[5, 5, 5]} intensity={1.0} color={HOLO_COLOUR} />
        <pointLight
          position={[-4, -2, -3]}
          intensity={0.4}
          color={HOLO_COLOUR}
        />
        <Stars
          radius={40}
          depth={30}
          count={1200}
          factor={1.5}
          fade
          speed={0.3}
        />
        <Globe onPick={onPick} autoRotate={autoRotate} />
        <OrbitControls
          enablePan={false}
          enableZoom
          minDistance={1.6}
          maxDistance={6}
          autoRotate={autoRotate}
          autoRotateSpeed={0.3}
          rotateSpeed={0.6}
        />
      </Canvas>
      <CornerHints />
    </div>
  );
}

/**
 * Holographic shader material — multiplies the Earth texture by a
 * cyan tint, adds fresnel rim glow at the silhouette, and overlays
 * subtle scanlines so the surface reads as a JARVIS hologram instead
 * of a realistic globe.
 */
function useHologramMaterial(): THREE.ShaderMaterial {
  return useMemo(() => {
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    const texture = loader.load(EARTH_TEXTURE_URL);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    return new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: texture },
        uColour: { value: new THREE.Color(HOLO_COLOUR) },
        uTime: { value: 0 },
        uOpacity: { value: 0.92 },
      },
      transparent: true,
      depthWrite: true,
      vertexShader: /* glsl */ `
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewDir = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        uniform vec3 uColour;
        uniform float uTime;
        uniform float uOpacity;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec2 vUv;

        void main() {
          // Sample the Earth surface, then push it through a
          // luminance-only filter so we ignore the original colours
          // and keep the geographic detail (continents/clouds).
          vec3 sampled = texture2D(uTex, vUv).rgb;
          float lum = dot(sampled, vec3(0.299, 0.587, 0.114));
          // Map luminance to a cyan ramp — dark ocean → mid-blue,
          // light land/clouds → bright cyan. Brighter floor so the
          // ocean reads as glowing-cyan-with-detail rather than
          // black void.
          float pop = pow(lum, 1.2);
          vec3 base = mix(uColour * 0.32, uColour * 1.95, pop);

          // Fresnel rim glow — softens the silhouette so the planet
          // appears to hover. Toned down so it doesn't blow out
          // the surface detail on the visible disk.
          float fres = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.5);
          base += uColour * fres * 0.45;

          // Scanlines — slow vertical sweep over the surface so the
          // hologram feels alive but doesn't overpower the geography.
          float scan = 0.95 + 0.05 * sin(vUv.y * 220.0 + uTime * 0.6);
          base *= scan;

          gl_FragColor = vec4(base, uOpacity);
        }
      `,
    });
  }, []);
}

function Globe({
  onPick,
  autoRotate,
}: {
  onPick?: (c: { lat: number; lon: number }) => void;
  autoRotate: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const material = useHologramMaterial();

  // Drive the scanline phase + slow planet rotation. Initial Y
  // rotation is set on first mount so the user sees a continent-rich
  // hemisphere (Africa / Europe) instead of an empty Pacific.
  useFrame((state, delta) => {
    if (!groupRef.current) return;
    if (autoRotate) {
      groupRef.current.rotation.y += delta * 0.05;
    }
    material.uniforms.uTime.value = state.clock.elapsedTime;
  });

  return (
    <group ref={groupRef} rotation={[0, -0.5, 0]}>
      {/* The textured holographic Earth itself. */}
      <mesh
        data-testid="globe-pickable"
        material={material}
        onClick={(e) => {
          e.stopPropagation();
          if (!onPick) return;
          const local = e.point.clone();
          if (groupRef.current) {
            local.applyMatrix4(
              new THREE.Matrix4().copy(groupRef.current.matrixWorld).invert(),
            );
          }
          local.normalize();
          // The Earth texture's UV mapping puts the prime meridian
          // (lon = 0) at u = 0.5 (texture center). With a default
          // sphereGeometry the +z axis aligns with u = 0.25 (90°W),
          // so lon = atan2(z, x) - 90°.
          const lat = THREE.MathUtils.radToDeg(Math.asin(local.y));
          let lon =
            THREE.MathUtils.radToDeg(Math.atan2(local.z, local.x)) - 90;
          if (lon > 180) lon -= 360;
          if (lon < -180) lon += 360;
          onPick({ lat, lon });
        }}
      >
        <sphereGeometry args={[RADIUS, 96, 64]} />
      </mesh>

      {/* Atmosphere halo — back-side fresnel sphere, slightly
          larger than the planet so it rims the silhouette. Soft
          and translucent so it doesn't drown the planet detail. */}
      <mesh>
        <sphereGeometry args={[RADIUS * 1.05, 64, 32]} />
        <shaderMaterial
          transparent
          depthWrite={false}
          side={THREE.BackSide}
          uniforms={{
            uColour: { value: new THREE.Color(HOLO_COLOUR) },
          }}
          vertexShader={/* glsl */ `
            varying vec3 vNormal;
            varying vec3 vViewDir;
            void main() {
              vNormal = normalize(normalMatrix * normal);
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              vViewDir = normalize(-mv.xyz);
              gl_Position = projectionMatrix * mv;
            }
          `}
          fragmentShader={/* glsl */ `
            uniform vec3 uColour;
            varying vec3 vNormal;
            varying vec3 vViewDir;
            void main() {
              float fres = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 3.0);
              gl_FragColor = vec4(uColour, fres * 0.5);
            }
          `}
        />
      </mesh>
    </group>
  );
}

function CornerHints() {
  return (
    <>
      <div
        className="mono"
        style={{
          position: "absolute",
          left: 12,
          bottom: 10,
          fontSize: 9,
          letterSpacing: 1.5,
          color: "var(--hud)",
          opacity: 0.7,
          pointerEvents: "none",
          textShadow: "0 0 6px var(--orb-glow)",
        }}
      >
        DRAG · ROTATE   PINCH · ZOOM   CLICK · DROP PIN
      </div>
      <div
        className="mono"
        style={{
          position: "absolute",
          right: 12,
          top: 10,
          fontSize: 9,
          letterSpacing: 1.5,
          color: "var(--hud)",
          opacity: 0.7,
          pointerEvents: "none",
          textShadow: "0 0 6px var(--orb-glow)",
        }}
      >
        EARTH · LIVE
      </div>
    </>
  );
}
