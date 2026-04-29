"use client";

/**
 * HolographicEarth — JARVIS-style 3D globe.
 *
 * Aesthetic: wireframe sphere + latitude/longitude grid lines + a
 * faint glow halo, all in Alfred's cyan palette. No realistic
 * texture — this is meant to read as a hologram.
 *
 * Interaction:
 *   - Drag to rotate (OrbitControls).
 *   - Scroll / pinch to zoom in & out.
 *   - Click to pick a lat/lon — the parent gets the picked point and
 *     can transition to a detailed map view.
 *
 * Lazy-loaded by the parent (React.lazy) because react-three-fiber
 * pulls in three.js (~600 KB minified) — we don't want it on the
 * initial bundle for users who never open the globe.
 */

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import { useRef } from "react";
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
const HOLO_DIM = "#2c6c8a";

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
        borderRadius: 4,
        overflow: "hidden",
        background:
          "radial-gradient(ellipse at center, rgba(108,214,255,0.06), transparent 65%)",
      }}
    >
      <Canvas
        camera={{ position: [0, 0.6, 3.2], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.6} />
        <pointLight position={[5, 5, 5]} intensity={0.5} color={HOLO_COLOUR} />
        <Stars
          radius={40}
          depth={30}
          count={1500}
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
 * The sphere itself + grid + glow halo. Click handler converts the
 * hit point on the sphere surface (in local mesh coordinates) to
 * geographic lat/lon and bubbles up via ``onPick``.
 */
function Globe({
  onPick,
  autoRotate,
}: {
  onPick?: (c: { lat: number; lon: number }) => void;
  autoRotate: boolean;
}) {
  const groupRef = useRef<THREE.Group>(null);

  // Slow self-rotation when idle. OrbitControls' autoRotate handles
  // the *camera* — this rotates the whole group so the picked
  // point math (which uses the local frame) stays consistent.
  useFrame((_, delta) => {
    if (!autoRotate) return;
    // Orbit handles rotation; no extra group rotation needed.
    void delta;
  });

  return (
    <group ref={groupRef}>
      {/* Solid filled sphere for hit-testing — opaque material so
          OrbitControls' raycasts land on the surface, but we crank
          the metalness/roughness/transparency so visually it's almost
          all wireframe. */}
      <mesh
        data-testid="globe-pickable"
        onClick={(e) => {
          e.stopPropagation();
          if (!onPick) return;
          // ``e.point`` is in world space. Convert to the group's
          // local space by applying the inverse world matrix, then
          // turn the unit-sphere-surface point into lat/lon.
          const local = e.point.clone();
          if (groupRef.current) {
            local.applyMatrix4(
              new THREE.Matrix4().copy(groupRef.current.matrixWorld).invert(),
            );
          }
          local.normalize();
          // Y axis is "up" in three.js; latitude = asin(y), longitude
          // = atan2(z, x). Subtract 90° so the prime meridian aligns
          // with the +x axis (roughly the "default" hologram view).
          const lat = THREE.MathUtils.radToDeg(Math.asin(local.y));
          let lon = THREE.MathUtils.radToDeg(Math.atan2(local.z, local.x));
          // Clamp into [-180, 180].
          if (lon > 180) lon -= 360;
          if (lon < -180) lon += 360;
          onPick({ lat, lon });
        }}
      >
        <sphereGeometry args={[RADIUS, 64, 48]} />
        <meshStandardMaterial
          color={"#0a1424"}
          emissive={HOLO_DIM}
          emissiveIntensity={0.18}
          roughness={1}
          metalness={0.1}
          transparent
          opacity={0.55}
        />
      </mesh>

      {/* Wireframe overlay — true geodesic lines over the surface. */}
      <mesh>
        <sphereGeometry args={[RADIUS * 1.001, 36, 24]} />
        <meshBasicMaterial
          color={HOLO_COLOUR}
          wireframe
          transparent
          opacity={0.45}
        />
      </mesh>

      {/* Latitude rings — equator + tropic of cancer/capricorn +
          arctic/antarctic circles. Drawn brighter than the wireframe
          so the planet's geometry reads at a glance. */}
      <LatitudeRing latDeg={0} brightness={1} />
      <LatitudeRing latDeg={23.5} brightness={0.55} />
      <LatitudeRing latDeg={-23.5} brightness={0.55} />
      <LatitudeRing latDeg={66.5} brightness={0.4} />
      <LatitudeRing latDeg={-66.5} brightness={0.4} />

      {/* Glow halo — billboard ring slightly larger than the sphere
          to suggest atmospheric scatter. */}
      <mesh>
        <ringGeometry args={[RADIUS * 1.04, RADIUS * 1.18, 96]} />
        <meshBasicMaterial
          color={HOLO_COLOUR}
          transparent
          opacity={0.12}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/**
 * A horizontal ring at the given latitude. Draws as a tube along
 * the parametric circle so it has perceptible thickness against
 * the scatter-stars background.
 */
function LatitudeRing({
  latDeg,
  brightness = 1,
}: {
  latDeg: number;
  brightness?: number;
}) {
  const phi = THREE.MathUtils.degToRad(latDeg);
  const ringRadius = Math.cos(phi) * RADIUS * 1.001;
  const yOffset = Math.sin(phi) * RADIUS * 1.001;
  return (
    <mesh position={[0, yOffset, 0]} rotation={[Math.PI / 2, 0, 0]}>
      <torusGeometry args={[ringRadius, 0.004, 8, 96]} />
      <meshBasicMaterial
        color={HOLO_COLOUR}
        transparent
        opacity={0.55 * brightness}
      />
    </mesh>
  );
}

/** Bottom-corner UI hints overlaid on the canvas (DOM, not WebGL). */
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
