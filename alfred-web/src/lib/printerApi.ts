/**
 * Printer API — wraps the alfred-core ``/printer/*`` endpoints,
 * which proxy through to the user's Creality K1 Max via the
 * Moonraker JSON-API the printer already exposes on port 7125.
 *
 * The client never talks to Moonraker directly: we route through
 * the backend so the printer URL + any auth token live in
 * server-side env (``ALFRED_PRINTER_URL``, ``ALFRED_PRINTER_API_KEY``)
 * and never end up baked into the public JS bundle.
 */

import { API_BASE } from "@/lib/api";

export type PrinterState =
  | "ready"
  | "printing"
  | "paused"
  | "error"
  | "disconnected"
  | "unknown";

export interface PrinterStatus {
  state: PrinterState;
  state_message: string;
  /** Currently-loaded gcode filename, if any. */
  filename: string | null;
  /** 0..1 progress through the current print, if any. */
  progress: number;
  /** Seconds elapsed in the current print. */
  print_duration: number;
  /** Backend's best estimate of seconds remaining, if any. */
  estimated_time_left_seconds: number | null;
  temps: {
    extruder: { actual: number; target: number };
    bed: { actual: number; target: number };
    chamber?: { actual: number; target: number };
  };
  configured: boolean;
}

export async function getPrinterStatus(): Promise<PrinterStatus> {
  const resp = await fetch(`${API_BASE}/printer/status`);
  if (!resp.ok) {
    throw new Error(`Printer status failed: ${resp.status}`);
  }
  return resp.json() as Promise<PrinterStatus>;
}

export async function pausePrint(): Promise<void> {
  const resp = await fetch(`${API_BASE}/printer/pause`, { method: "POST" });
  if (!resp.ok) throw new Error(`Pause failed: ${resp.status}`);
}

export async function resumePrint(): Promise<void> {
  const resp = await fetch(`${API_BASE}/printer/resume`, { method: "POST" });
  if (!resp.ok) throw new Error(`Resume failed: ${resp.status}`);
}

export async function cancelPrint(): Promise<void> {
  const resp = await fetch(`${API_BASE}/printer/cancel`, { method: "POST" });
  if (!resp.ok) throw new Error(`Cancel failed: ${resp.status}`);
}
