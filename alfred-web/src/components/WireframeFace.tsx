"use client";

/**
 * WireframeFace — the abstract 3D wire-mesh head Alfred presents on
 * the embedded desk touchscreen.
 *
 * Geometry: MediaPipe's canonical face model (468 vertices, 898
 * triangles, served from ``/models/canonical_face_model.obj``). Its
 * killer property: vertex order == face-landmark order, so every
 * published landmark index (lips, eyelids, chin…) addresses a real
 * vertex — which is how the mouth and blinks are animated without
 * any rigged/skinned model.
 *
 * Three draw layers SHARE one position BufferAttribute, so a single
 * per-frame vertex write animates all of them:
 *   - LineSegments over the unique triangle edges (the wire mesh)
 *   - Points at every vertex (glowing nodes)
 *   - A near-transparent triangle fill for depth occlusion cues
 *
 * Animation inputs come as getter props (read inside the rAF loop —
 * zero React re-renders per frame):
 *   - getLevel(): TTS amplitude 0..1 → jaw open + glow
 *   - getMode():  idle/listening/thinking/speaking → palette + rings
 *   - getGaze():  normalized user position from webcam face tracking
 *                 → head yaw/pitch + iris offset ("looks at you").
 *                 Falls back to a slow idle drift when no face.
 *
 * Plain Three.js (no react-three-fiber) — one canvas, one rAF loop,
 * tight control over per-vertex updates, light enough for a Pi 5.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";

import type { OrbMode } from "@/lib/orbState";

export interface GazeTarget {
  /** -1 (viewer's left) .. +1 (viewer's right). */
  x: number;
  /** -1 (top of frame) .. +1 (bottom). */
  y: number;
  /** False → no face detected; head falls back to idle drift. */
  active: boolean;
}

export interface WireframeFaceProps {
  getMode: () => OrbMode;
  getLevel: () => number;
  getGaze: () => GazeTarget;
}

const MODEL_URL = "/models/canonical_face_model.obj";
const VCOUNT = 468;
const HEAD_HEIGHT = 3.0; // normalized model height in world units
const JAW_AMP = 0.27; // max chin drop at full mouth-open

// MediaPipe landmark indices used for animation anchors.
const LM = {
  upperLipInner: 13,
  lowerLipInner: 14,
  chin: 152,
  rEyeOuter: 33,
  rEyeInner: 133,
  rLidTop: 159,
  rLidBottom: 145,
  lEyeOuter: 263,
  lEyeInner: 362,
  lLidTop: 386,
  lLidBottom: 374,
};
// Inner-lower-lip ring — gets extra jaw weight so the lips visibly part.
const LOWER_INNER_LIP = [14, 87, 317, 178, 402, 88, 318, 95, 324];
// Inner-upper-lip ring — raised slightly as the mouth opens.
const UPPER_INNER_LIP = [13, 82, 312, 81, 311, 80, 310, 191, 415];

const MODE_COLORS: Record<OrbMode, THREE.Color> = {
  idle: new THREE.Color(0x6cd6ff),
  listening: new THREE.Color(0xa5e9ff),
  thinking: new THREE.Color(0xd6a85a),
  speaking: new THREE.Color(0x8fe0ff),
};

interface ParsedObj {
  positions: Float32Array;
  triIndices: number[];
}

/** Minimal OBJ parse — v lines in order (== landmark order), f lines
 *  as "f v/vt v/vt v/vt" triangles. OBJLoader is avoided on purpose:
 *  it de-indexes geometry, which would destroy the vertex↔landmark
 *  mapping the whole animation relies on. */
function parseObj(text: string): ParsedObj {
  const positions: number[] = [];
  const triIndices: number[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("v ")) {
      const p = line.slice(2).trim().split(/\s+/);
      positions.push(Number(p[0]), Number(p[1]), Number(p[2]));
    } else if (line.startsWith("f ")) {
      const refs = line.slice(2).trim().split(/\s+/);
      const idx = refs.map((r) => Number(r.split("/")[0]) - 1);
      for (let i = 1; i + 1 < idx.length; i++) {
        triIndices.push(idx[0], idx[i], idx[i + 1]);
      }
    }
  }
  return { positions: new Float32Array(positions), triIndices };
}

/** Unique undirected edges from the triangle list → LineSegments index. */
function buildEdgeIndices(tri: number[]): number[] {
  const seen = new Set<number>();
  const edges: number[] = [];
  const push = (a: number, b: number) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = lo * VCOUNT + hi;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(lo, hi);
  };
  for (let i = 0; i < tri.length; i += 3) {
    push(tri[i], tri[i + 1]);
    push(tri[i + 1], tri[i + 2]);
    push(tri[i + 2], tri[i]);
  }
  return edges;
}

/** Radial-gradient sprite texture for the soft glow behind the head. */
function makeGlowTexture(): THREE.Texture {
  const size = 256;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2,
  );
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.25)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

/** HUD-style arc (partial circle) as a Line in the XY plane. */
function makeArc(
  radius: number,
  startDeg: number,
  spanDeg: number,
  mat: THREE.LineBasicMaterial,
): THREE.Line {
  const curve = new THREE.EllipseCurve(
    0, 0, radius, radius,
    THREE.MathUtils.degToRad(startDeg),
    THREE.MathUtils.degToRad(startDeg + spanDeg),
    false, 0,
  );
  const pts = curve.getPoints(64);
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  return new THREE.Line(geo, mat);
}

export function WireframeFace({ getMode, getLevel, getGaze }: WireframeFaceProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Stable getter access for the rAF loop, immune to prop identity churn.
  const apiRef = useRef({ getMode, getLevel, getGaze });
  apiRef.current = { getMode, getLevel, getGaze };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let raf: number | null = null;
    let renderer: THREE.WebGLRenderer | null = null;
    let onResize: (() => void) | null = null;
    const disposables: Array<{ dispose: () => void }> = [];

    void (async () => {
      let parsed: ParsedObj;
      try {
        const res = await fetch(MODEL_URL);
        if (!res.ok) throw new Error(`model fetch ${res.status}`);
        parsed = parseObj(await res.text());
      } catch {
        if (!disposed && hostRef.current) {
          hostRef.current.dataset.faceError = "model";
        }
        return;
      }
      if (disposed || parsed.positions.length < VCOUNT * 3) return;

      // ── Normalize: center at origin, height = HEAD_HEIGHT ────────
      const base = parsed.positions.slice();
      const bb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      for (let i = 0; i < base.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (base[i + a] < bb.min[a]) bb.min[a] = base[i + a];
          if (base[i + a] > bb.max[a]) bb.max[a] = base[i + a];
        }
      }
      const center = [0, 1, 2].map((a) => (bb.min[a] + bb.max[a]) / 2);
      const scale = HEAD_HEIGHT / (bb.max[1] - bb.min[1]);
      for (let i = 0; i < base.length; i += 3) {
        base[i] = (base[i] - center[0]) * scale;
        base[i + 1] = (base[i + 1] - center[1]) * scale;
        base[i + 2] = (base[i + 2] - center[2]) * scale;
      }
      const X = (i: number) => base[i * 3];
      const Y = (i: number) => base[i * 3 + 1];
      const Z = (i: number) => base[i * 3 + 2];

      // ── Precompute animation weights ─────────────────────────────
      const mouthY = (Y(LM.upperLipInner) + Y(LM.lowerLipInner)) / 2;
      const chinY = Y(LM.chin);
      const jawRange = Math.max(1e-4, mouthY - chinY);
      let zMax = -Infinity;
      for (let i = 0; i < VCOUNT; i++) if (Z(i) > zMax) zMax = Z(i);

      const jawW = new Float32Array(VCOUNT);
      const upW = new Float32Array(VCOUNT);
      for (let i = 0; i < VCOUNT; i++) {
        const dy = mouthY - Y(i);
        if (dy > 0) {
          // Deeper below the mouth → stronger; frontal verts (chin,
          // lips) move fully, jaw sides near the ears barely.
          const depth = Math.min(1, dy / (jawRange * 1.6)) ** 0.9;
          const front = Math.max(0, Z(i) / zMax) ** 1.3;
          jawW[i] = depth * front;
        }
      }
      for (const i of LOWER_INNER_LIP) jawW[i] = Math.min(1.45, jawW[i] + 0.55);
      for (const i of UPPER_INNER_LIP) upW[i] = 1;

      // Blink weights: pull lid-region verts toward the eye centerline.
      const eyeC = (outer: number, inner: number, top: number, bottom: number) => ({
        x: (X(outer) + X(inner)) / 2,
        y: (Y(top) + Y(bottom)) / 2,
        z: (Z(outer) + Z(inner)) / 2,
        r: Math.hypot(X(outer) - X(inner), Y(outer) - Y(inner)) * 0.95,
      });
      const eyeR = eyeC(LM.rEyeOuter, LM.rEyeInner, LM.rLidTop, LM.rLidBottom);
      const eyeL = eyeC(LM.lEyeOuter, LM.lEyeInner, LM.lLidTop, LM.lLidBottom);
      const eyeW = new Float32Array(VCOUNT);
      const eyeCY = new Float32Array(VCOUNT);
      for (let i = 0; i < VCOUNT; i++) {
        for (const e of [eyeR, eyeL]) {
          const d = Math.hypot(X(i) - e.x, Y(i) - e.y);
          if (d < e.r) {
            const fall = (1 - d / e.r) ** 1.4;
            // Upper lid sweeps down hard; lower lid rises a little.
            eyeW[i] = fall * (Y(i) > e.y ? 0.95 : 0.3);
            eyeCY[i] = e.y;
          }
        }
      }

      // ── Scene graph ──────────────────────────────────────────────
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(
        36,
        host.clientWidth / Math.max(1, host.clientHeight),
        0.1,
        100,
      );
      camera.position.set(0, 0, 7.2);

      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(host.clientWidth, host.clientHeight);
      renderer.setClearColor(0x000000, 0);
      host.appendChild(renderer.domElement);

      const positions = base.slice();
      const posAttr = new THREE.BufferAttribute(positions, 3);

      const fillGeo = new THREE.BufferGeometry();
      fillGeo.setAttribute("position", posAttr);
      fillGeo.setIndex(parsed.triIndices);
      const fillMat = new THREE.MeshBasicMaterial({
        color: 0x6cd6ff,
        transparent: true,
        opacity: 0.035,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const fill = new THREE.Mesh(fillGeo, fillMat);

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute("position", posAttr);
      lineGeo.setIndex(buildEdgeIndices(parsed.triIndices));
      const lineMat = new THREE.LineBasicMaterial({
        color: 0x6cd6ff,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const wire = new THREE.LineSegments(lineGeo, lineMat);

      const pointGeo = new THREE.BufferGeometry();
      pointGeo.setAttribute("position", posAttr);
      const pointMat = new THREE.PointsMaterial({
        color: 0x9fe4ff,
        size: 0.022,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      });
      const nodes = new THREE.Points(pointGeo, pointMat);

      // Iris glyphs — a ring + core dot floating just off each eye.
      const irisMat = new THREE.MeshBasicMaterial({
        color: 0xbfefff,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const makeIris = () => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(new THREE.RingGeometry(0.045, 0.06, 24), irisMat));
        g.add(new THREE.Mesh(new THREE.CircleGeometry(0.018, 16), irisMat));
        return g;
      };
      const irisRight = makeIris();
      const irisLeft = makeIris();

      const headGroup = new THREE.Group();
      headGroup.add(fill, wire, nodes, irisRight, irisLeft);
      scene.add(headGroup);

      // Soft glow halo behind the head.
      const glowMat = new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        color: 0x2a86b8,
        transparent: true,
        opacity: 0.14,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(6.4, 6.4, 1);
      glow.position.z = -0.8;
      scene.add(glow);

      // HUD orbit rings — tilted arc clusters that slowly precess.
      const ringMat1 = new THREE.LineBasicMaterial({
        color: 0x6cd6ff, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const ringMat2 = ringMat1.clone();
      ringMat2.opacity = 0.14;
      const ringA = new THREE.Group();
      ringA.add(makeArc(2.0, 0, 250, ringMat1), makeArc(2.06, 280, 50, ringMat1));
      ringA.rotation.x = Math.PI / 2.25;
      const ringB = new THREE.Group();
      ringB.add(makeArc(2.35, 90, 160, ringMat2), makeArc(2.42, 300, 90, ringMat2));
      ringB.rotation.set(Math.PI / 2.6, 0.5, 0.25);
      scene.add(ringA, ringB);

      // Ambient particle shell for depth.
      const pCount = 220;
      const pPos = new Float32Array(pCount * 3);
      for (let i = 0; i < pCount; i++) {
        const r = 2.8 + Math.random() * 2.2;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        pPos[i * 3 + 1] = r * Math.cos(ph) * 0.7;
        pPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th) - 1.2;
      }
      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
      const pMat = new THREE.PointsMaterial({
        color: 0x3f7f9f, size: 0.02, transparent: true, opacity: 0.45,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const particles = new THREE.Points(pGeo, pMat);
      scene.add(particles);

      disposables.push(
        fillGeo, fillMat, lineGeo, lineMat, pointGeo, pointMat,
        irisMat, glowMat, ringMat1, ringMat2, pGeo, pMat,
      );

      onResize = () => {
        if (!renderer || !hostRef.current) return;
        const w = hostRef.current.clientWidth;
        const h = Math.max(1, hostRef.current.clientHeight);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener("resize", onResize);

      // ── Animation state ──────────────────────────────────────────
      const sm = { level: 0, open: 0, yaw: 0, pitch: 0 };
      const blink = { start: -1, next: 1.5 + Math.random() * 2 };
      const tmpColor = new THREE.Color();

      const tick = (now: number) => {
        if (disposed || !renderer) return;
        const t = now / 1000;
        const api = apiRef.current;
        const mode = api.getMode();
        const level = api.getLevel();

        sm.level += (Math.min(1, level) - sm.level) * 0.35;
        const openTarget = mode === "speaking" ? Math.min(1, sm.level * 2.4) : 0;
        sm.open += (openTarget - sm.open) * 0.3;

        // Gaze — webcam target, else slow idle wander.
        const g = api.getGaze();
        let targetYaw: number;
        let targetPitch: number;
        if (g.active) {
          targetYaw = THREE.MathUtils.clamp(g.x, -1, 1) * 0.42;
          targetPitch = THREE.MathUtils.clamp(g.y, -1, 1) * 0.3;
        } else {
          targetYaw = Math.sin(t * 0.23) * 0.14 + Math.sin(t * 0.71) * 0.04;
          targetPitch = Math.sin(t * 0.17) * 0.08;
        }
        sm.yaw += (targetYaw - sm.yaw) * 0.06;
        sm.pitch += (targetPitch - sm.pitch) * 0.06;
        headGroup.rotation.set(sm.pitch, sm.yaw, 0);
        headGroup.position.y = Math.sin(t * 0.8) * 0.035;

        // Blink scheduling — quick sine pulse every few seconds.
        if (t >= blink.next) {
          blink.start = t;
          blink.next = t + 2.2 + Math.random() * 3.8;
        }
        const bt = (t - blink.start) / 0.18;
        const blinkPhase = bt >= 0 && bt <= 1 ? Math.sin(bt * Math.PI) : 0;

        // ── Per-vertex deform: jaw + lips + lids ───────────────────
        const open = sm.open;
        for (let i = 0; i < VCOUNT; i++) {
          const by = base[i * 3 + 1];
          const bz = base[i * 3 + 2];
          let y = by;
          let z = bz;
          const jw = jawW[i];
          if (jw > 0 && open > 0.001) {
            y -= jw * open * JAW_AMP;
            z -= jw * open * JAW_AMP * 0.35;
          }
          if (upW[i] > 0) y += upW[i] * open * 0.07;
          const ew = eyeW[i];
          if (ew > 0 && blinkPhase > 0) y += (eyeCY[i] - by) * ew * blinkPhase;
          positions[i * 3 + 1] = y;
          positions[i * 3 + 2] = z;
        }
        posAttr.needsUpdate = true;

        // ── Palette + intensity per mode ───────────────────────────
        tmpColor.copy(MODE_COLORS[mode]);
        lineMat.color.lerp(tmpColor, 0.08);
        pointMat.color.lerp(tmpColor, 0.08);
        fillMat.color.copy(lineMat.color);
        ringMat1.color.lerp(tmpColor, 0.05);
        ringMat2.color.copy(ringMat1.color);
        glowMat.color.lerp(tmpColor, 0.05);

        const breath = 0.5 + 0.5 * Math.sin(t * 1.4);
        if (mode === "speaking" || mode === "listening") {
          lineMat.opacity = 0.48 + sm.level * 0.5;
        } else if (mode === "thinking") {
          lineMat.opacity = 0.5 + 0.18 * Math.sin(t * 9);
        } else {
          lineMat.opacity = 0.42 + breath * 0.12;
        }
        pointMat.opacity = Math.min(1, lineMat.opacity + 0.18);
        fillMat.opacity = 0.03 + sm.open * 0.035;
        glowMat.opacity =
          0.12 + sm.level * (mode === "speaking" ? 0.3 : 0.12) + breath * 0.03;

        // Irises lead the gaze slightly — "locked on" feel.
        irisRight.position.set(
          eyeR.x + sm.yaw * 0.1, eyeR.y - sm.pitch * 0.08, eyeR.z + 0.05,
        );
        irisLeft.position.set(
          eyeL.x + sm.yaw * 0.1, eyeL.y - sm.pitch * 0.08, eyeL.z + 0.05,
        );
        const irisFade = 1 - blinkPhase;
        irisMat.opacity = (0.55 + sm.level * 0.4) * irisFade;

        // Rings precess; thinking mode spins them up 4×.
        const spin = mode === "thinking" ? 4 : 1;
        ringA.rotation.z += 0.0022 * spin;
        ringB.rotation.z -= 0.0015 * spin;
        particles.rotation.y += 0.0004;

        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      disposed = true;
      if (raf !== null) cancelAnimationFrame(raf);
      if (onResize) window.removeEventListener("resize", onResize);
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      if (renderer) {
        try {
          renderer.dispose();
          renderer.domElement.remove();
        } catch {
          /* ignore */
        }
        renderer = null;
      }
    };
  }, []);

  return (
    <div
      ref={hostRef}
      data-testid="wireframe-face-canvas"
      style={{ position: "absolute", inset: 0, overflow: "hidden" }}
    />
  );
}
