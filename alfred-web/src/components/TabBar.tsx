"use client";

/**
 * TabBar — three-tab top navigation: HUD · CHAT · DESIGN.
 *
 * Sits above the existing button toolbar. Highlights the active
 * tab, fires ``onChange`` when the user clicks a tab, and shows a
 * subtle hint about the two-hand sliding-door gesture (so the
 * user remembers they can swipe instead of click).
 *
 * Each tab gets a ``data-testid`` so end-to-end tests can switch
 * tabs deterministically.
 */

import type { TabId } from "@/lib/tabs";
import { TAB_LABELS, TAB_ORDER } from "@/lib/tabs";

interface Props {
  active: TabId;
  onChange: (tab: TabId) => void;
}

export function TabBar({ active, onChange }: Props) {
  return (
    <div
      data-testid="tab-bar"
      style={{
        position: "relative",
        display: "flex",
        gap: 6,
        padding: "8px 14px 6px",
        // Sit on top of the page background; tabs are the user's
        // primary nav so they get prime real estate above the
        // existing tools toolbar.
        background:
          "linear-gradient(180deg, rgba(8,14,24,0.92) 0%, rgba(8,14,24,0.45) 100%)",
        borderBottom: "1px solid rgba(108,214,255,0.18)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
      }}
    >
      {TAB_ORDER.map((id) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            type="button"
            data-testid={`tab-${id}`}
            data-active={isActive ? "1" : "0"}
            onClick={() => onChange(id)}
            style={{
              flex: 1,
              padding: "8px 14px",
              background: isActive
                ? "rgba(108,214,255,0.18)"
                : "rgba(8,14,24,0.55)",
              border: `1px solid ${isActive ? "var(--orb)" : "var(--border)"}`,
              borderRadius: 4,
              color: isActive ? "var(--orb)" : "var(--muted)",
              fontFamily:
                'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
              fontSize: 12,
              letterSpacing: 2,
              textTransform: "uppercase",
              cursor: "pointer",
              transition: "all 180ms ease",
              boxShadow: isActive
                ? "0 0 14px var(--orb-glow), inset 0 0 10px rgba(108,214,255,0.15)"
                : "none",
              fontWeight: isActive ? 600 : 400,
            }}
            aria-current={isActive ? "page" : undefined}
          >
            {TAB_LABELS[id]}
          </button>
        );
      })}
      <div
        aria-hidden
        style={{
          position: "absolute",
          right: 14,
          top: -2,
          fontSize: 8,
          opacity: 0.45,
          letterSpacing: 1.5,
          textTransform: "uppercase",
          color: "var(--muted)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          pointerEvents: "none",
        }}
      >
        ⇿ two-hand swipe to switch
      </div>
    </div>
  );
}
