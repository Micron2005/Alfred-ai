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
import { OrbitControls } from "@react-three/drei";
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
  /** Device-location pins to drop on the globe surface. Each pin
   *  pulses softly so it reads as "live data", not static geometry. */
  pins?: ReadonlyArray<{ lat: number; lon: number; label?: string | null }>;
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
  pins = [],
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
        <Globe onPick={onPick} autoRotate={autoRotate} pins={pins} />
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
  pins,
}: {
  onPick?: (c: { lat: number; lon: number }) => void;
  autoRotate: boolean;
  pins: ReadonlyArray<{ lat: number; lon: number; label?: string | null }>;
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
          // Three.js' default sphereGeometry maps the standard Blue
          // Marble equirectangular texture so:
          //   - +X axis  → prime meridian (lon = 0°, Greenwich)
          //   - −Z axis  → lon = +90° (India / Bay of Bengal)
          //   - −X axis  → lon = ±180° (date line)
          //   - +Z axis  → lon = −90° (USA west coast)
          //   - +Y axis  → north pole
          // ⇒ lat = asin(y), lon = atan2(−z, x).
          //
          // Older code used ``atan2(z, x) − 90°`` which combined a
          // wrong sign on z with a 90° offset, producing clicks that
          // landed ~16° east of where the user clicked — clicking NYC
          // returned lon=−16° (mid-Atlantic), exactly what users
          // reported as "click on USA → I get put in the ocean".
          const lat = THREE.MathUtils.radToDeg(Math.asin(local.y));
          let lon = THREE.MathUtils.radToDeg(
            Math.atan2(-local.z, local.x),
          );
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

      {/* Orbital rings — two thin angled torus loops around the
          planet, evoking satellite paths. Tilted on different axes
          so they read as arcs around the globe in motion. */}
      <mesh rotation={[Math.PI / 2.4, 0.4, 0.2]}>
        <torusGeometry args={[RADIUS * 1.18, 0.0035, 8, 96]} />
        <meshBasicMaterial color={HOLO_COLOUR} transparent opacity={0.55} />
      </mesh>
      <mesh rotation={[Math.PI / 1.7, -0.3, 0.6]}>
        <torusGeometry args={[RADIUS * 1.22, 0.0028, 8, 96]} />
        <meshBasicMaterial color={HOLO_COLOUR} transparent opacity={0.4} />
      </mesh>

      {/* Device-location pins — each one is a tiny pulsing sphere
          anchored slightly above the globe surface at the lat/lon.
          The matching ``latLonToVec3`` formula here MUST stay in
          sync with the click-pick formula above (same "lon - 90°"
          rotation), otherwise pins would appear offset from where
          the user clicked. */}
      {pins.map((p, i) => (
        <DevicePin key={`${p.lat.toFixed(3)}-${p.lon.toFixed(3)}-${i}`} lat={p.lat} lon={p.lon} />
      ))}
    </group>
  );
}

function latLonToVec3(lat: number, lon: number, radius: number): THREE.Vector3 {
  // Inverse of the click-pick formula. The corrected click is:
  //   lat = asin(y), lon = atan2(−z, x).
  // ⇒ to drop a pin at (lat, lon), place it at:
  //   x = cos(lat) · cos(lon), y = sin(lat), z = −cos(lat) · sin(lon)
  // Verified by round-trip: (lat=40.7, lon=−74) → (0.209, 0.652, 0.728)
  // → click formula returns (40.7, −73.97). Within float epsilon.
  const latRad = THREE.MathUtils.degToRad(lat);
  const lonRad = THREE.MathUtils.degToRad(lon);
  const cosLat = Math.cos(latRad);
  return new THREE.Vector3(
    radius * cosLat * Math.cos(lonRad),
    radius * Math.sin(latRad),
    -radius * cosLat * Math.sin(lonRad),
  );
}

function DevicePin({ lat, lon }: { lat: number; lon: number }) {
  const dotRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const pos = latLonToVec3(lat, lon, RADIUS * 1.005);
  // Rotate the pin so the dot points outward along the surface
  // normal — the ring then sits flat against the globe.
  const normal = pos.clone().normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    normal,
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    // Pulse — sin from 0..1, scales the ring 1.0..1.4 and fades
    // opacity inversely.
    if (ringRef.current) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.0);
      const scale = 1 + pulse * 0.6;
      ringRef.current.scale.setScalar(scale);
      const mat = ringRef.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.85 * (1 - pulse);
    }
    if (dotRef.current) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.0 + 0.5);
      dotRef.current.scale.setScalar(1 + pulse * 0.15);
    }
  });

  return (
    <group position={pos.toArray()} quaternion={quat.toArray()}>
      {/* Solid centre dot */}
      <mesh ref={dotRef}>
        <sphereGeometry args={[0.012, 16, 16]} />
        <meshBasicMaterial color="#ff8a4c" />
      </mesh>
      {/* Pulsing ring (a flat ring above the dot's base plane). */}
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.014, 0.024, 24]} />
        <meshBasicMaterial color="#ff8a4c" transparent depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

