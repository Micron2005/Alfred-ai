/**
 * Vitals + Workshop API client — Alfred's self-diagnostics & self-coding.
 *
 * Vitals tells the user (and Alfred himself) when something's off about
 * his own setup. Workshop lets him read his own source and propose
 * patches when something needs fixing.
 */

import { API_BASE, FETCH_DEFAULTS } from "@/lib/api";

export type VitalStatus = "ok" | "warn" | "err" | "off";

export interface Vital {
  id: string;
  label: string;
  status: VitalStatus;
  detail: string;
  fix: string;
}

export interface VitalsReport {
  vitals: Vital[];
}

export async function fetchVitals(): Promise<VitalsReport> {
  const resp = await fetch(`${API_BASE}/vitals`, FETCH_DEFAULTS);
  if (!resp.ok) throw new Error(`Vitals failed: ${resp.status}`);
  return resp.json() as Promise<VitalsReport>;
}

// ─── Workshop ───────────────────────────────────────────────────────────

export interface WorkshopFile {
  path: string;
  size: number;
}

export interface WorkshopFileList {
  files: WorkshopFile[];
}

export async function listWorkshopFiles(): Promise<WorkshopFileList> {
  const resp = await fetch(`${API_BASE}/workshop/files`, FETCH_DEFAULTS);
  if (!resp.ok) throw new Error(`Could not list workshop files: ${resp.status}`);
  return resp.json() as Promise<WorkshopFileList>;
}

export interface WorkshopFileContent {
  path: string;
  content: string;
  size: number;
}

export async function readWorkshopFile(path: string): Promise<WorkshopFileContent> {
  const url = new URL(`${API_BASE}/workshop/file`);
  url.searchParams.set("path", path);
  const resp = await fetch(url.toString(), FETCH_DEFAULTS);
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Could not read ${path}: ${resp.status} ${detail}`);
  }
  return resp.json() as Promise<WorkshopFileContent>;
}

export interface DiagnoseRequest {
  problem: string;
  paths: string[];
}

export interface DiagnoseReply {
  explanation: string;
  backend: string;
  model: string;
}

export async function diagnoseProblem(
  req: DiagnoseRequest,
): Promise<DiagnoseReply> {
  const resp = await fetch(`${API_BASE}/workshop/diagnose`, {
    ...FETCH_DEFAULTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Diagnose failed: ${resp.status} ${detail}`);
  }
  return resp.json() as Promise<DiagnoseReply>;
}

export interface ApplyReply {
  applied: boolean;
  detail: string;
  files_touched: string[];
}

export async function applyWorkshopPatch(diff: string): Promise<ApplyReply> {
  const resp = await fetch(`${API_BASE}/workshop/apply`, {
    ...FETCH_DEFAULTS,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diff }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Apply failed: ${resp.status} ${detail}`);
  }
  return resp.json() as Promise<ApplyReply>;
}
