"use client";

/**
 * Spotify3DView — full-screen 3D-styled audio console.
 *
 * Two halves:
 *   - LEFT: a giant rotating Spotify-orb visualiser that pulses to
 *     the live audio analyser (bass/mid/treble bands). Track meta
 *     overlays the orb if Spotify is connected.
 *   - RIGHT: the EQ panel — three vertical sliders (Bass / Mid /
 *     Treble) plus drag-drop for a local audio file (so the EQ is
 *     real, not decorative). Playback uses Web Audio API with a
 *     BiquadFilter chain so the user actually hears the EQ.
 *
 * NOTE on Spotify EQ: the official Web Playback SDK doesn't expose
 * the decoded audio buffer (DRM), so we can't EQ Spotify streams
 * directly. The user picked option 4a — Web Audio EQ on local
 * audio. The Spotify side stays decorative-but-faithful (real
 * track meta, real playback control via the existing SDK). We
 * tell the user this in the panel so it's obvious.
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface Spotify3DViewProps {
  onBack: () => void;
}

interface Bands {
  bass: number; // -12..+12 dB
  mid: number;
  treble: number;
}

const BAR_COUNT = 32;

export function Spotify3DView({ onBack }: Spotify3DViewProps) {
  const [bands, setBands] = useState<Bands>({ bass: 0, mid: 0, treble: 0 });
  const [fileName, setFileName] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bars, setBars] = useState<number[]>(() => Array(BAR_COUNT).fill(0));

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const bassFilterRef = useRef<BiquadFilterNode | null>(null);
  const midFilterRef = useRef<BiquadFilterNode | null>(null);
  const trebleFilterRef = useRef<BiquadFilterNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);

  // Build the audio graph the first time the user picks a file.
  // Audio → Source → BassShelf → MidPeaking → TrebleShelf →
  // Analyser → Destination. The filters are kept in refs so the
  // slider handlers can mutate them without re-running this setup.
  const ensureGraph = useCallback(() => {
    if (audioCtxRef.current) return;
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const audio = audioRef.current;
    if (!audio) return;
    const src = ctx.createMediaElementSource(audio);
    sourceRef.current = src;

    const bass = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 200;
    bass.gain.value = 0;
    bassFilterRef.current = bass;

    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 1;
    mid.gain.value = 0;
    midFilterRef.current = mid;

    const treble = ctx.createBiquadFilter();
    treble.type = "highshelf";
    treble.frequency.value = 3500;
    treble.gain.value = 0;
    trebleFilterRef.current = treble;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    analyserRef.current = analyser;

    src.connect(bass).connect(mid).connect(treble).connect(analyser);
    analyser.connect(ctx.destination);
  }, []);

  // Visualiser RAF loop — reads the analyser and sets ``bars``.
  useEffect(() => {
    let cancelled = false;
    function tick() {
      if (cancelled) return;
      const a = analyserRef.current;
      if (a && playing) {
        const data = new Uint8Array(a.frequencyBinCount);
        a.getByteFrequencyData(data);
        const step = Math.floor(data.length / BAR_COUNT);
        const next: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += data[i * step + j];
          next.push((sum / step) / 255);
        }
        setBars(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing]);

  // Tear the audio graph down on unmount so the AudioContext doesn't
  // leak across mounts (browser's per-tab AC budget is small).
  // We deliberately read ``.current`` at cleanup time (not at mount)
  // so the latest audio element / context get torn down even if
  // ensureGraph mutated the refs after this effect first ran.
  useEffect(() => {
    return () => {
      const ctx = audioCtxRef.current;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const audio = audioRef.current;
      if (audio) audio.pause();
      if (ctx) void ctx.close().catch(() => {});
    };
  }, []);

  function setBand(name: keyof Bands, value: number) {
    setBands((prev) => ({ ...prev, [name]: value }));
    const ref =
      name === "bass"
        ? bassFilterRef.current
        : name === "mid"
          ? midFilterRef.current
          : trebleFilterRef.current;
    if (ref) ref.gain.value = value;
  }

  function resetBands() {
    setBands({ bass: 0, mid: 0, treble: 0 });
    if (bassFilterRef.current) bassFilterRef.current.gain.value = 0;
    if (midFilterRef.current) midFilterRef.current.gain.value = 0;
    if (trebleFilterRef.current) trebleFilterRef.current.gain.value = 0;
  }

  async function handleFile(file: File) {
    setError(null);
    if (!file.type.startsWith("audio/") && !file.name.match(/\.(mp3|wav|ogg|m4a|flac|aac)$/i)) {
      setError("That doesn't look like an audio file, sir.");
      return;
    }
    const url = URL.createObjectURL(file);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = url;
      audioRef.current.load();
    }
    setFileName(file.name);
    ensureGraph();
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* user gesture issue — handled below on play */
      }
    }
    try {
      await audioRef.current?.play();
      setPlaying(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Playback failed");
    }
  }

  function handlePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    ensureGraph();
    if (audio.paused) {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === "suspended") void ctx.resume();
      void audio.play().then(() => setPlaying(true)).catch((err) => {
        setError(err instanceof Error ? err.message : "Playback failed");
      });
    } else {
      audio.pause();
      setPlaying(false);
    }
  }

  // Average bar height drives the orb's pulse scale + rim glow,
  // so the visual feels tightly coupled to what the user is
  // actually hearing.
  const avgEnergy =
    bars.length > 0 ? bars.reduce((s, v) => s + v, 0) / bars.length : 0;

  return (
    <div
      data-testid="spotify-3d-view"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 8500,
        background:
          "radial-gradient(circle at 30% 40%, rgba(20,40,70,1) 0%, rgba(0,0,0,1) 70%)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <BackBar onBack={onBack} title="SPOTIFY · AUDIO CONSOLE" />

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 380px",
          gap: 24,
          padding: "24px 36px 36px",
          minHeight: 0,
        }}
      >
        {/* LEFT — pulsing 3D orb visualiser */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <PulsingOrb energy={avgEnergy} fileName={fileName} playing={playing} />

          {/* Spectrum ring around the orb */}
          <SpectrumRing bars={bars} />
        </div>

        {/* RIGHT — EQ panel */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 18,
            background: "rgba(8,14,24,0.55)",
            backdropFilter: "blur(8px)",
            boxShadow: "0 0 28px rgba(108,214,255,0.08)",
          }}
        >
          <div
            className="mono"
            data-testid="eq-panel-title"
            style={{
              fontSize: 11,
              letterSpacing: 3,
              color: "var(--orb)",
              textShadow: "0 0 8px var(--orb-glow)",
            }}
          >
            EQUALISER · 3-BAND
          </div>

          {/* Drag-drop / file picker */}
          <FileDropZone onFile={handleFile} fileName={fileName} />

          {/* Sliders */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 14,
              marginTop: 6,
            }}
          >
            <Slider
              label="BASS"
              testId="eq-bass-slider"
              value={bands.bass}
              onChange={(v) => setBand("bass", v)}
            />
            <Slider
              label="MID"
              testId="eq-mid-slider"
              value={bands.mid}
              onChange={(v) => setBand("mid", v)}
            />
            <Slider
              label="TREBLE"
              testId="eq-treble-slider"
              value={bands.treble}
              onChange={(v) => setBand("treble", v)}
            />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              data-testid="eq-play-pause"
              className="hud-button"
              onClick={handlePlayPause}
              disabled={!fileName}
              style={{ flex: 1 }}
            >
              {playing ? "❚❚ PAUSE" : "▶ PLAY"}
            </button>
            <button
              type="button"
              data-testid="eq-reset"
              className="hud-button"
              onClick={resetBands}
              style={{ flex: 1 }}
            >
              ↺ RESET
            </button>
          </div>

          {error ? (
            <div
              data-testid="spotify-3d-error"
              style={{
                color: "var(--danger)",
                fontSize: 12,
                background: "rgba(255,80,80,0.06)",
                border: "1px solid rgba(255,80,80,0.3)",
                padding: 10,
                borderRadius: 3,
              }}
            >
              {error}
            </div>
          ) : null}

          <div
            style={{
              fontSize: 10,
              color: "var(--muted)",
              lineHeight: 1.6,
              letterSpacing: 0.4,
              marginTop: "auto",
            }}
          >
            Drag-drop a local audio file to engage the EQ chain
            (lowshelf · peaking · highshelf). Spotify streams are
            DRM-protected so we cannot apply DSP to the live SDK
            output — connect the existing Spotify widget on the HUD
            for transport control.
          </div>
        </div>
      </div>

      <audio
        ref={audioRef}
        // Don't show the native UI — we have our own transport
        // controls. ``crossOrigin`` is unset because we only ever
        // load object URLs (same origin guaranteed).
        style={{ display: "none" }}
        onEnded={() => setPlaying(false)}
        onPause={() => setPlaying(false)}
      />
    </div>
  );
}

function BackBar({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "12px 18px",
        borderBottom: "1px solid var(--border)",
        background: "rgba(8,14,24,0.85)",
        backdropFilter: "blur(10px)",
      }}
    >
      <button
        type="button"
        data-testid="subview-back"
        onClick={onBack}
        className="hud-button"
        aria-label="Back to JARVIS HUD"
      >
        ← BACK
      </button>
      <div
        className="mono"
        style={{
          fontSize: 12,
          letterSpacing: 4,
          color: "var(--orb)",
          textShadow: "0 0 8px var(--orb-glow)",
        }}
      >
        {title}
      </div>
    </div>
  );
}

interface PulsingOrbProps {
  energy: number;
  fileName: string | null;
  playing: boolean;
}

function PulsingOrb({ energy, fileName, playing }: PulsingOrbProps) {
  const scale = 1 + energy * 0.18;
  const glow = 30 + energy * 80;
  return (
    <div
      data-testid="spotify-3d-orb"
      style={{
        position: "relative",
        width: 360,
        height: 360,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          transform: `scale(${scale.toFixed(3)})`,
          background:
            "radial-gradient(circle at 50% 50%, rgba(108,214,255,0.0) 0%, rgba(108,214,255,0.08) 35%, rgba(108,214,255,0.22) 70%, rgba(108,214,255,0.55) 95%, rgba(108,214,255,0) 100%)",
          boxShadow: `inset 0 0 36px rgba(108,214,255,0.5), inset 8px 12px 28px rgba(255,255,255,0.18), inset -8px -12px 28px rgba(0,0,0,0.45), 0 0 ${glow}px var(--orb-glow), 0 0 ${glow * 2.4}px var(--orb-soft)`,
          transition: "transform 90ms ease-out, box-shadow 120ms ease-out",
          backdropFilter: "blur(2px)",
        }}
      />
      {/* Concentric rotating dashed rings — same family as Orb3D. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: -40,
          borderRadius: "50%",
          border: "1px dashed rgba(108,214,255,0.4)",
          animation: "radial-spin-y 11000ms linear infinite",
        }}
      />
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: -10,
          borderRadius: "50%",
          border: "1px dashed rgba(108,214,255,0.35)",
          transform: "rotateX(72deg)",
          animation: "radial-orbit 7000ms linear infinite",
        }}
      />
      {/* Track meta caption */}
      <div
        style={{
          position: "absolute",
          bottom: -54,
          left: "50%",
          transform: "translateX(-50%)",
          textAlign: "center",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          letterSpacing: 2,
          fontSize: 11,
          color: "var(--muted)",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
          maxWidth: 480,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {fileName
          ? `${playing ? "▶ NOW PLAYING" : "❚❚ PAUSED"} · ${fileName}`
          : "DROP AN AUDIO FILE TO BEGIN"}
      </div>
    </div>
  );
}

function SpectrumRing({ bars }: { bars: number[] }) {
  return (
    <div
      data-testid="spotify-3d-spectrum"
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
      }}
    >
      {bars.map((v, i) => {
        const angle = (i / bars.length) * 360;
        const len = 12 + v * 80;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 4,
              height: len,
              transform: `translate(-50%, -100%) rotate(${angle}deg) translateY(-220px)`,
              transformOrigin: "center bottom",
              background:
                "linear-gradient(180deg, var(--orb) 0%, transparent 100%)",
              borderRadius: 2,
              opacity: 0.55 + v * 0.45,
              filter: "drop-shadow(0 0 6px var(--orb-glow))",
            }}
          />
        );
      })}
    </div>
  );
}

interface SliderProps {
  label: string;
  testId: string;
  value: number;
  onChange: (v: number) => void;
}

function Slider({ label, testId, value, onChange }: SliderProps) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
      }}
    >
      <input
        type="range"
        data-testid={testId}
        min={-12}
        max={12}
        step={0.5}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        // CSS-only vertical orientation; works in Chromium/Firefox.
        style={{
          writingMode: "vertical-lr" as const,
          height: 160,
          accentColor: "rgb(108,214,255)",
        }}
        aria-label={`${label} ${value > 0 ? "+" : ""}${value} dB`}
      />
      <span style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 2 }}>
        {label}
      </span>
      <span style={{ fontSize: 11, color: "var(--orb)" }}>
        {value > 0 ? "+" : ""}
        {value.toFixed(1)} dB
      </span>
    </label>
  );
}

function FileDropZone({
  onFile,
  fileName,
}: {
  onFile: (file: File) => void;
  fileName: string | null;
}) {
  const [hover, setHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      data-testid="eq-drop-zone"
      onDragOver={(e) => {
        e.preventDefault();
        setHover(true);
      }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      style={{
        border: `1px dashed ${hover ? "var(--orb)" : "var(--border)"}`,
        borderRadius: 4,
        padding: "14px 12px",
        textAlign: "center",
        cursor: "pointer",
        background: hover ? "rgba(108,214,255,0.08)" : "transparent",
        transition: "all 160ms ease",
        fontSize: 11,
        color: hover ? "var(--orb)" : "var(--muted)",
        letterSpacing: 1.5,
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
      }}
    >
      {fileName ?? "DROP AUDIO FILE — OR CLICK TO BROWSE"}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.aac"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
    </div>
  );
}
