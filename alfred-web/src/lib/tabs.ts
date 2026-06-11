"use client";

/** Top-level tabs the user can swipe between with a two-hand
 *  sliding-door gesture (or click). The WORKOUT tab is
 *  dedicated to the form-coach experience so the HUD stays
 *  focused on standby / overview. CAD lives behind DESIGN.  */
export type TabId = "hud" | "chat" | "workout" | "design";

export const TAB_ORDER: ReadonlyArray<TabId> = [
  "hud",
  "chat",
  "workout",
  "design",
];

export const TAB_LABELS: Record<TabId, string> = {
  hud: "HUD",
  chat: "CHAT",
  workout: "WORKOUT",
  design: "DESIGN",
};

/** Returns the next tab in the given direction, wrapping at the
 *  ends so the swipe gesture always lands somewhere. */
export function neighbourTab(current: TabId, direction: "left" | "right"): TabId {
  const i = TAB_ORDER.indexOf(current);
  if (i < 0) return "hud";
  const delta = direction === "right" ? 1 : -1;
  const j = (i + delta + TAB_ORDER.length) % TAB_ORDER.length;
  return TAB_ORDER[j];
}

const TAB_KEY = "alfred.activeTab";

export function loadTab(): TabId {
  if (typeof window === "undefined") return "hud";
  const v = window.localStorage.getItem(TAB_KEY);
  if (v === "hud" || v === "chat" || v === "workout" || v === "design") return v;
  return "hud";
}

export function persistTab(tab: TabId): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TAB_KEY, tab);
}
