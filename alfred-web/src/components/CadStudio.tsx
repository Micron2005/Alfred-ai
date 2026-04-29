"use client";

/**
 * CadStudio — the from-scratch CAD viewport that replaces the
 * (previously OnShape-iframe-based) Design tab. Built on
 * react-three-fiber + drei so the user OWNS the tool — no
 * external service dependency.
 *
 * Capabilities (v1):
 *   - 3D viewport with orbit camera, ground plane (200×200 mm
 *     grid), soft contact shadow, hemisphere + key light.
 *   - Add primitives: cube, sphere, cylinder, cone, torus.
 *   - Click-to-select, transform gizmo (translate / rotate /
 *     scale switchable from the toolbar).
 *   - Properties panel: numeric inputs for size/position/rotation
 *     in millimetres, colour picker, primitive-specific detail
 *     slider, duplicate / delete buttons.
 *   - Auto-save to localStorage; refresh-safe.
 *   - STL export — emits a binary .stl ready for Creality slicer
 *     (or any other) at real-world millimetre scale.
 *
 * Internally everything works in MILLIMETRES so 3D printing
 * dimensions are unambiguous. The Three.js scene is scaled by
 * 0.01 (1 unit = 100 mm) to keep camera distances reasonable.
 */

import { Suspense, useMemo, useRef, useState } from "react";

import {
  ContactShadows,
  GizmoHelper,
  GizmoViewport,
  Grid,
  OrbitControls,
  TransformControls,
} from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { STLExporter } from "three-stdlib";
import * as THREE from "three";

import {
  type CadNode,
  type CadPrimitive,
  type GizmoMode,
  useCadStore,
} from "@/lib/cadStore";

const SCENE_SCALE = 0.01; // 1 unit = 100 mm. Easier to orbit than 1 unit = 1 mm.

const PRIMITIVES: ReadonlyArray<{ id: CadPrimitive; label: string; icon: string }> = [
  { id: "cube", label: "Cube", icon: "▦" },
  { id: "sphere", label: "Sphere", icon: "●" },
  { id: "cylinder", label: "Cylinder", icon: "◉" },
  { id: "cone", label: "Cone", icon: "▲" },
  { id: "torus", label: "Torus", icon: "◯" },
];

export function CadStudio() {
  return (
    <div
      data-testid="cad-studio"
      style={{
        position: "relative",
        flex: 1,
        display: "flex",
        minHeight: 0,
        background: "#06090f",
      }}
    >
      <Toolbar />
      <ViewportFrame />
      <PropertiesPanel />
    </div>
  );
}

// ─── Toolbar ────────────────────────────────────────────────────────────────

function Toolbar() {
  const addPrimitive = useCadStore((s) => s.addPrimitive);
  const setMode = useCadStore((s) => s.setMode);
  const gizmoMode = useCadStore((s) => s.gizmoMode);
  const clear = useCadStore((s) => s.clear);
  const nodes = useCadStore((s) => s.nodes);
  const sceneRef = useSceneRef();

  function exportStl() {
    const sceneRoot = sceneRef.current?.scene;
    if (!sceneRoot) return;
    // The exporter walks the scene; we feed it the "designables"
    // group only so the grid + helpers don't end up in the .stl.
    const designables = sceneRoot.getObjectByName("designables");
    if (!designables) return;
    // Bake the SCENE_SCALE back out so the exported geometry is in
    // real millimetres — what every slicer expects.
    const cloned = designables.clone(true);
    cloned.scale.setScalar(1 / SCENE_SCALE);
    cloned.updateMatrixWorld(true);
    const exporter = new STLExporter();
    const data = exporter.parse(cloned, { binary: true }) as DataView;
    // Cast through the underlying ArrayBuffer because TS's
    // DataView<ArrayBufferLike> isn't assignable to BlobPart.
    const blob = new Blob([data.buffer as ArrayBuffer], {
      type: "model/stl",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `alfred-design-${stamp}.stl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div
      data-testid="cad-toolbar"
      style={{
        width: 88,
        background: "rgba(8, 14, 24, 0.85)",
        borderRight: "1px solid var(--border)",
        backdropFilter: "blur(10px)",
        padding: "12px 8px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        alignItems: "stretch",
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 9,
        color: "var(--hud)",
        flexShrink: 0,
      }}
    >
      <Section title="ADD">
        {PRIMITIVES.map((p) => (
          <ToolButton
            key={p.id}
            label={p.label}
            icon={p.icon}
            onClick={() => addPrimitive(p.id)}
            testId={`add-${p.id}`}
          />
        ))}
      </Section>
      <Section title="GIZMO">
        {(["translate", "rotate", "scale"] as GizmoMode[]).map((m) => (
          <ToolButton
            key={m}
            label={m.toUpperCase()}
            icon={m === "translate" ? "↔" : m === "rotate" ? "↻" : "⇲"}
            active={gizmoMode === m}
            onClick={() => setMode(m)}
            testId={`gizmo-${m}`}
          />
        ))}
      </Section>
      <Section title="EXPORT">
        <ToolButton
          label="STL"
          icon="⤓"
          onClick={exportStl}
          disabled={nodes.length === 0}
          testId="export-stl"
        />
      </Section>
      <div style={{ flex: 1 }} />
      <Section title="">
        <ToolButton
          label="CLEAR"
          icon="✕"
          onClick={() => {
            if (window.confirm("Clear the entire scene?")) clear();
          }}
          danger
          testId="clear-scene"
        />
      </Section>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {title ? (
        <div
          style={{
            opacity: 0.55,
            letterSpacing: 1.6,
            fontSize: 8,
            paddingLeft: 2,
          }}
        >
          {title}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function ToolButton({
  label,
  icon,
  active,
  onClick,
  disabled,
  danger,
  testId,
}: {
  label: string;
  icon: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        padding: "8px 4px",
        background: active
          ? "rgba(108,214,255,0.18)"
          : "rgba(0,0,0,0.25)",
        border: `1px solid ${
          active
            ? "var(--orb)"
            : danger
              ? "rgba(255,120,120,0.4)"
              : "var(--border)"
        }`,
        borderRadius: 4,
        color: danger ? "rgba(255,120,120,0.95)" : "var(--hud)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        fontFamily: "inherit",
        fontSize: 8,
        letterSpacing: 1.4,
        textTransform: "uppercase",
        boxShadow: active ? "0 0 8px var(--orb-glow)" : "none",
        transition: "all 160ms ease",
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1 }}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// ─── Viewport ───────────────────────────────────────────────────────────────

interface SceneHandle {
  scene: THREE.Scene | null;
}

const _sceneSlot: SceneHandle = { scene: null };

function useSceneRef(): { current: SceneHandle | null } {
  // Lightweight singleton — the scene gets registered by SceneCapture
  // below. We avoid a context here so the toolbar can call exportStl
  // from outside the Canvas tree.
  return { current: _sceneSlot };
}

function ViewportFrame() {
  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Canvas
        camera={{ position: [0.6, 0.5, 0.8], fov: 45, near: 0.01, far: 50 }}
        shadows
        style={{ flex: 1, background: "transparent" }}
        onPointerMissed={() => useCadStore.getState().select(null)}
      >
        <SceneCapture />
        <Lighting />
        <Grid
          args={[2, 2]}
          cellSize={0.05}
          cellThickness={0.5}
          sectionSize={0.1}
          sectionThickness={1}
          sectionColor="#3a4a66"
          cellColor="#1c2434"
          fadeDistance={3}
          fadeStrength={1}
          infiniteGrid
        />
        <ContactShadows
          position={[0, 0, 0]}
          opacity={0.4}
          scale={4}
          blur={2.5}
          far={1}
        />
        <Suspense fallback={null}>
          <Designables />
        </Suspense>
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
          <GizmoViewport
            axisColors={["#ff7878", "#66f0a0", "#6cd6ff"]}
            labelColor="#fff"
          />
        </GizmoHelper>
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          minDistance={0.05}
          maxDistance={5}
          target={[0, 0.05, 0]}
        />
      </Canvas>
      <ViewportLegend />
    </div>
  );
}

function SceneCapture() {
  // Captures the live three.js Scene into the singleton slot so the
  // out-of-canvas toolbar can run STLExporter against it.
  const { scene } = useThree();
  _sceneSlot.scene = scene;
  return null;
}

function Lighting() {
  return (
    <>
      <hemisphereLight args={["#a6d4ff", "#1c2434", 0.7]} />
      <directionalLight
        position={[1.5, 2, 1.5]}
        intensity={1.0}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <ambientLight intensity={0.25} />
    </>
  );
}

function Designables() {
  const nodes = useCadStore((s) => s.nodes);
  const selectedId = useCadStore((s) => s.selectedId);
  return (
    <group name="designables" scale={SCENE_SCALE}>
      {nodes.map((node) => (
        <Designable
          key={node.id}
          node={node}
          isSelected={node.id === selectedId}
        />
      ))}
    </group>
  );
}

function Designable({
  node,
  isSelected,
}: {
  node: CadNode;
  isSelected: boolean;
}) {
  const select = useCadStore((s) => s.select);
  const updateNode = useCadStore((s) => s.updateNode);
  const gizmoMode = useCadStore((s) => s.gizmoMode);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const orbitsRef = useRef<{ enabled: boolean }>(null);

  const geometry = useMemo(() => buildGeometry(node), [node]);

  const handleObjectChange = () => {
    const m = meshRef.current;
    if (!m) return;
    updateNode(node.id, {
      position: { x: m.position.x, y: m.position.y, z: m.position.z },
      rotation: { x: m.rotation.x, y: m.rotation.y, z: m.rotation.z },
      // For uniform scale changes we let the gizmo bake into size,
      // re-derive size from mesh.scale * stored size.
      size: gizmoMode === "scale"
        ? {
            x: node.size.x * m.scale.x,
            y: node.size.y * m.scale.y,
            z: node.size.z * m.scale.z,
          }
        : node.size,
    });
    // Reset scale after baking so the next gizmo drag isn't compounded.
    if (gizmoMode === "scale") {
      m.scale.set(1, 1, 1);
    }
  };

  const meshNode = (
    <mesh
      ref={meshRef}
      castShadow
      receiveShadow
      position={[node.position.x, node.position.y, node.position.z]}
      rotation={[node.rotation.x, node.rotation.y, node.rotation.z]}
      onPointerDown={(e) => {
        e.stopPropagation();
        select(node.id);
      }}
    >
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial
        color={node.color}
        roughness={0.45}
        metalness={0.05}
        emissive={isSelected ? "#0a3a55" : "#000000"}
        emissiveIntensity={isSelected ? 0.35 : 0}
      />
    </mesh>
  );

  if (!isSelected) return meshNode;

  return (
    <TransformControls
      object={meshRef}
      mode={gizmoMode}
      size={0.6}
      onMouseDown={() => {
        if (orbitsRef.current) orbitsRef.current.enabled = false;
      }}
      onMouseUp={() => {
        if (orbitsRef.current) orbitsRef.current.enabled = true;
      }}
      onObjectChange={handleObjectChange}
    >
      {meshNode}
    </TransformControls>
  );
}

function buildGeometry(node: CadNode): THREE.BufferGeometry {
  const { primitive, size, detail } = node;
  switch (primitive) {
    case "cube":
      return new THREE.BoxGeometry(size.x, size.y, size.z);
    case "sphere":
      return new THREE.SphereGeometry(
        size.x / 2,
        Math.max(8, detail),
        Math.max(6, Math.floor(detail / 1.5)),
      );
    case "cylinder":
      return new THREE.CylinderGeometry(
        size.x / 2,
        size.z / 2,
        size.y,
        Math.max(6, detail),
      );
    case "cone":
      return new THREE.ConeGeometry(
        size.x / 2,
        size.y,
        Math.max(6, detail),
      );
    case "torus":
      return new THREE.TorusGeometry(
        size.x / 2,
        size.y / 2,
        Math.max(6, Math.floor(detail / 2)),
        Math.max(8, detail),
      );
  }
}

function ViewportLegend() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 16,
        top: 16,
        padding: "6px 10px",
        background: "rgba(8, 14, 24, 0.7)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 10,
        color: "var(--muted)",
        letterSpacing: 1.4,
        pointerEvents: "none",
        backdropFilter: "blur(8px)",
      }}
    >
      drag to orbit · scroll to zoom · units = mm
    </div>
  );
}

// ─── Properties / Scene tree ────────────────────────────────────────────────

function PropertiesPanel() {
  const nodes = useCadStore((s) => s.nodes);
  const selectedId = useCadStore((s) => s.selectedId);
  const select = useCadStore((s) => s.select);
  const remove = useCadStore((s) => s.remove);
  const duplicate = useCadStore((s) => s.duplicate);
  const updateNode = useCadStore((s) => s.updateNode);
  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div
      data-testid="cad-properties"
      style={{
        width: 260,
        background: "rgba(8, 14, 24, 0.85)",
        borderLeft: "1px solid var(--border)",
        backdropFilter: "blur(10px)",
        padding: "12px 12px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        fontSize: 11,
        color: "var(--hud)",
        flexShrink: 0,
        overflowY: "auto",
      }}
    >
      <div style={{ letterSpacing: 2, fontSize: 10, opacity: 0.7 }}>SCENE</div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          maxHeight: 160,
          overflowY: "auto",
          padding: 4,
          background: "rgba(0,0,0,0.25)",
          border: "1px solid var(--border)",
          borderRadius: 3,
        }}
      >
        {nodes.length === 0 ? (
          <div style={{ opacity: 0.55, fontStyle: "italic", padding: 6 }}>
            Empty. Add a primitive from the toolbar.
          </div>
        ) : (
          nodes.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => select(n.id)}
              data-testid={`scene-node-${n.id}`}
              style={{
                textAlign: "left",
                padding: "4px 6px",
                background:
                  n.id === selectedId
                    ? "rgba(108,214,255,0.18)"
                    : "transparent",
                border: "1px solid transparent",
                borderColor:
                  n.id === selectedId ? "var(--orb)" : "transparent",
                borderRadius: 3,
                color: "var(--hud)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 11,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: n.color,
                  border: "1px solid rgba(0,0,0,0.5)",
                }}
              />
              <span style={{ flex: 1 }}>{n.name}</span>
            </button>
          ))
        )}
      </div>

      {selected ? (
        <SelectedEditor
          node={selected}
          onUpdate={(patch) => updateNode(selected.id, patch)}
          onDuplicate={() => duplicate(selected.id)}
          onDelete={() => remove(selected.id)}
        />
      ) : (
        <div style={{ opacity: 0.55, fontStyle: "italic", fontSize: 10 }}>
          Click an object in the viewport or scene list to edit it.
        </div>
      )}
    </div>
  );
}

function SelectedEditor({
  node,
  onUpdate,
  onDuplicate,
  onDelete,
}: {
  node: CadNode;
  onUpdate: (patch: Partial<CadNode>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <input
        type="text"
        value={node.name}
        onChange={(e) => onUpdate({ name: e.target.value })}
        data-testid="prop-name"
        style={inputStyle}
      />
      <Vec3Input
        label="SIZE (mm)"
        value={node.size}
        min={0.5}
        step={1}
        onChange={(size) => onUpdate({ size })}
      />
      <Vec3Input
        label="POSITION (mm)"
        value={node.position}
        step={1}
        onChange={(position) => onUpdate({ position })}
      />
      <Vec3Input
        label="ROTATION (rad)"
        value={node.rotation}
        step={0.05}
        precision={3}
        onChange={(rotation) => onUpdate({ rotation })}
      />
      <div>
        <Label>COLOR</Label>
        <input
          type="color"
          value={node.color}
          onChange={(e) => onUpdate({ color: e.target.value })}
          data-testid="prop-color"
          style={{
            width: "100%",
            height: 28,
            border: "1px solid var(--border)",
            borderRadius: 3,
            background: "transparent",
          }}
        />
      </div>
      <div>
        <Label>DETAIL</Label>
        <input
          type="range"
          min={4}
          max={64}
          step={4}
          value={node.detail}
          onChange={(e) =>
            onUpdate({ detail: Number.parseInt(e.target.value, 10) })
          }
          data-testid="prop-detail"
          style={{ width: "100%" }}
        />
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="hud-button"
          onClick={onDuplicate}
          data-testid="prop-duplicate"
          style={{ flex: 1, padding: "5px 6px", fontSize: 10 }}
        >
          DUPLICATE
        </button>
        <button
          type="button"
          className="hud-button"
          onClick={onDelete}
          data-testid="prop-delete"
          style={{
            flex: 1,
            padding: "5px 6px",
            fontSize: 10,
            color: "rgba(255,120,120,0.95)",
            borderColor: "rgba(255,120,120,0.5)",
          }}
        >
          DELETE
        </button>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        opacity: 0.6,
        letterSpacing: 1.4,
        fontSize: 8,
        marginBottom: 3,
      }}
    >
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(0,0,0,0.4)",
  color: "var(--hud)",
  border: "1px solid var(--border)",
  borderRadius: 3,
  padding: "4px 6px",
  fontSize: 11,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

function Vec3Input({
  label,
  value,
  step = 1,
  min,
  precision,
  onChange,
}: {
  label: string;
  value: { x: number; y: number; z: number };
  step?: number;
  min?: number;
  precision?: number;
  onChange: (v: { x: number; y: number; z: number }) => void;
}) {
  const fmt = (n: number) =>
    precision !== undefined ? Number(n.toFixed(precision)) : Number(n.toFixed(2));
  return (
    <div>
      <Label>{label}</Label>
      <div style={{ display: "flex", gap: 4 }}>
        {(["x", "y", "z"] as const).map((axis) => (
          <input
            key={axis}
            type="number"
            value={fmt(value[axis])}
            step={step}
            min={min}
            onChange={(e) => {
              const next = Number.parseFloat(e.target.value);
              if (Number.isNaN(next)) return;
              onChange({ ...value, [axis]: next });
            }}
            data-testid={`prop-${label.toLowerCase().split(" ")[0]}-${axis}`}
            style={{ ...inputStyle, padding: "3px 4px", fontSize: 10 }}
            aria-label={`${label} ${axis}`}
          />
        ))}
      </div>
    </div>
  );
}
