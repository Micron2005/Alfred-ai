"use client";

/**
 * Design3DView — full-screen Onshape browser launched from the
 * radial menu's "DESIGN" wedge.
 *
 * Layout mirrors Spotify3DView so the HUD feels consistent:
 *   - LEFT: a slowly-rotating wireframe cube (the same glyph as the
 *     radial entry, scaled up) — purely visual flourish.
 *   - RIGHT: tabbed browser (DOCUMENTS / NEW). DOCUMENTS lists the
 *     user's recent Onshape documents with thumbnails and an
 *     "Open in Onshape" button. NEW lets them create a fresh blank
 *     document by name.
 *
 * Auth & error model:
 *   - 409 from the backend → "Onshape isn't configured" hint with
 *     a link to the dev-portal docs.
 *   - 503 → transient Onshape outage / bad keys; surface as a
 *     dismissable error banner with a retry.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type OnshapeDocument,
  type OnshapeElement,
  type OnshapeStatus,
  buildOnshapeUrl,
  createOnshapeDocument,
  getOnshapeStatus,
  getOnshapeThumbnailUrl,
  listOnshapeDocuments,
  listOnshapeElements,
} from "@/lib/onshape";

interface Design3DViewProps {
  onBack: () => void;
}

type Tab = "documents" | "new";

export function Design3DView({ onBack }: Design3DViewProps) {
  const [status, setStatus] = useState<OnshapeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [tab, setTab] = useState<Tab>("documents");
  const [docs, setDocs] = useState<OnshapeDocument[] | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [activeDoc, setActiveDoc] = useState<OnshapeDocument | null>(null);
  const [elements, setElements] = useState<OnshapeElement[] | null>(null);
  const [elementsLoading, setElementsLoading] = useState(false);

  const [newName, setNewName] = useState("");

  // ─── Status ─────────────────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    try {
      const next = await getOnshapeStatus();
      setStatus(next);
      setStatusError(null);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setStatusError(message);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // ─── Document list ──────────────────────────────────────────────
  const loadDocs = useCallback(async (query: string) => {
    setError(null);
    try {
      const resp = await listOnshapeDocuments(query, 20, 0);
      setDocs(resp.items);
      // eslint-disable-next-line no-console
      console.info(`[design3d] loaded ${resp.items.length} documents`);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      // eslint-disable-next-line no-console
      console.error("[design3d] listDocuments failed:", exc);
      setError(`Couldn't load documents: ${message}`);
    }
  }, []);

  useEffect(() => {
    if (!status?.configured) return;
    void loadDocs("");
  }, [status?.configured, loadDocs]);

  // Debounced search.
  useEffect(() => {
    if (!status?.configured) return;
    const id = window.setTimeout(() => {
      void loadDocs(searchQuery);
    }, 350);
    return () => window.clearTimeout(id);
  }, [searchQuery, status?.configured, loadDocs]);

  // ─── Element list (when a doc is opened) ────────────────────────
  const openDoc = useCallback(async (doc: OnshapeDocument) => {
    setActiveDoc(doc);
    setElements(null);
    setElementsLoading(true);
    setError(null);
    try {
      const resp = await listOnshapeElements(doc.id);
      setElements(resp.items);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      // eslint-disable-next-line no-console
      console.error("[design3d] listElements failed:", exc);
      setError(`Couldn't load elements: ${message}`);
    } finally {
      setElementsLoading(false);
    }
  }, []);

  // ─── Create ─────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    const clean = newName.trim();
    if (!clean) {
      setError("Document name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createOnshapeDocument(clean);
      setNewName("");
      setTab("documents");
      // Eager prepend so the user sees their new doc immediately.
      setDocs((prev) => (prev ? [created, ...prev] : [created]));
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(`Couldn't create document: ${message}`);
    } finally {
      setBusy(false);
    }
  }, [newName]);

  // ─── Render ─────────────────────────────────────────────────────
  return (
    <div
      data-testid="design-3d-view"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 8500,
        background:
          "radial-gradient(circle at 30% 50%, rgba(20,40,70,1) 0%, rgba(0,0,0,1) 70%)",
        display: "flex",
        flexDirection: "column",
        color: "var(--fg)",
      }}
    >
      <BackBar onBack={onBack} title="DESIGN · ONSHAPE" />

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 480px",
          gap: 24,
          padding: "24px 36px 36px",
          minHeight: 0,
        }}
      >
        {/* LEFT — wireframe cube hero */}
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
          }}
        >
          <CubeHero docName={activeDoc?.name ?? null} />
        </div>

        {/* RIGHT — Onshape browser */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: 16,
            background: "rgba(8,14,24,0.55)",
            backdropFilter: "blur(8px)",
            boxShadow: "0 0 28px rgba(108,214,255,0.08)",
            minHeight: 0,
          }}
        >
          <div
            className="mono"
            style={{
              fontSize: 11,
              letterSpacing: 3,
              color: "var(--orb)",
              textShadow: "0 0 8px var(--orb-glow)",
            }}
          >
            DESIGN · LIBRARY
          </div>

          {/* State pill */}
          <div
            data-testid="design-3d-debug"
            style={{
              fontSize: 10,
              color: "var(--muted)",
              letterSpacing: 1.2,
              fontFamily:
                'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
              padding: "4px 8px",
              border: "1px dashed var(--border)",
              borderRadius: 3,
              background: "rgba(108,214,255,0.04)",
            }}
          >
            STATE · configured:
            <span
              style={{
                color: status?.configured ? "rgb(110,230,160)" : "rgb(255,160,80)",
                fontWeight: 600,
              }}
            >
              {status === null ? "?" : status.configured ? "Y" : "N"}
            </span>
            {status?.api_base ? (
              <>
                {" "}base:<span style={{ color: "var(--orb)" }}>{status.api_base}</span>
              </>
            ) : null}
          </div>

          {!status && !statusError ? (
            <Hint text="Connecting to Onshape…" />
          ) : statusError ? (
            <Hint text={`Onshape status error: ${statusError}`} kind="error" />
          ) : !status?.configured ? (
            <Hint
              text="Onshape isn't configured. Add ALFRED_ONSHAPE_ACCESS_KEY + ALFRED_ONSHAPE_SECRET_KEY to your .env, then `docker compose restart alfred-core`. Get the keys from https://dev-portal.onshape.com → Create new API Key."
              kind="error"
            />
          ) : activeDoc ? (
            <ElementsPane
              activeDoc={activeDoc}
              elements={elements}
              loading={elementsLoading}
              apiBase={status.api_base}
              onBack={() => {
                setActiveDoc(null);
                setElements(null);
              }}
            />
          ) : (
            <>
              <TabBar tab={tab} setTab={setTab} />
              {tab === "documents" ? (
                <DocumentsPane
                  docs={docs}
                  searchQuery={searchQuery}
                  onSearchChange={setSearchQuery}
                  onOpenDoc={openDoc}
                  apiBase={status.api_base}
                />
              ) : (
                <NewDocPane
                  name={newName}
                  onNameChange={setNewName}
                  onCreate={handleCreate}
                  busy={busy}
                />
              )}
            </>
          )}

          {error ? (
            <div
              data-testid="design-3d-error"
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
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

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

function TabBar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <TabButton active={tab === "documents"} onClick={() => setTab("documents")} testId="design-3d-tab-documents">
        DOCUMENTS
      </TabButton>
      <TabButton active={tab === "new"} onClick={() => setTab("new")} testId="design-3d-tab-new">
        NEW
      </TabButton>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={active ? "hud-button hud-button--primary" : "hud-button"}
      style={{ flex: 1, fontSize: 11, letterSpacing: 2 }}
    >
      {children}
    </button>
  );
}

function DocumentsPane({
  docs,
  searchQuery,
  onSearchChange,
  onOpenDoc,
  apiBase,
}: {
  docs: OnshapeDocument[] | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onOpenDoc: (doc: OnshapeDocument) => void;
  apiBase: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        flex: 1,
      }}
    >
      <input
        type="search"
        data-testid="design-3d-search-input"
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="Search documents…"
        style={{
          padding: "10px 12px",
          background: "rgba(8,14,24,0.7)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--fg)",
          fontSize: 14,
          outline: "none",
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--orb)";
          e.currentTarget.style.boxShadow = "0 0 0 1px var(--orb), 0 0 14px var(--orb-glow)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "var(--border)";
          e.currentTarget.style.boxShadow = "none";
        }}
      />
      {docs === null ? (
        <Hint text="Loading documents…" />
      ) : docs.length === 0 ? (
        <Hint text="No documents found. Create one via the NEW tab — or open Onshape directly to seed your library." />
      ) : (
        <div
          data-testid="design-3d-documents"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            overflowY: "auto",
            flex: 1,
            paddingRight: 4,
          }}
        >
          {docs.map((d) => (
            <DocumentRow
              key={d.id}
              doc={d}
              onOpen={() => onOpenDoc(d)}
              apiBase={apiBase}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentRow({
  doc,
  onOpen,
  apiBase,
}: {
  doc: OnshapeDocument;
  onOpen: () => void;
  apiBase: string;
}) {
  const [thumbErr, setThumbErr] = useState(false);
  const onshapeWebUrl = doc.default_workspace_id
    ? buildOnshapeUrl(apiBase, doc.id, doc.default_workspace_id)
    : null;
  return (
    <div
      data-testid={`design-3d-doc-${doc.id}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 10px",
        background: "transparent",
        border: "1px solid var(--border)",
        borderRadius: 4,
        color: "var(--fg)",
        textAlign: "left",
        transition: "background 140ms ease, border-color 140ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "rgba(108,214,255,0.07)";
        e.currentTarget.style.borderColor = "var(--orb)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "var(--border)";
      }}
    >
      {!thumbErr && doc.has_thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={getOnshapeThumbnailUrl(doc.id, "300x300")}
          alt=""
          width={44}
          height={44}
          style={{ borderRadius: 3, objectFit: "cover", flexShrink: 0 }}
          onError={() => setThumbErr(true)}
        />
      ) : (
        <div
          style={{
            width: 44,
            height: 44,
            background: "rgba(108,214,255,0.08)",
            border: "1px solid var(--border)",
            borderRadius: 3,
            flexShrink: 0,
          }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 13,
            color: "var(--fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {doc.name || "(untitled)"}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--muted)",
            letterSpacing: 1,
            marginTop: 2,
          }}
        >
          {doc.owner ? `${doc.owner} · ` : ""}
          {formatDate(doc.modified_at)}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button
          type="button"
          data-testid={`design-3d-doc-open-${doc.id}`}
          className="hud-button"
          onClick={onOpen}
          style={{ fontSize: 10, letterSpacing: 1.5 }}
        >
          OPEN
        </button>
        {onshapeWebUrl ? (
          <a
            data-testid={`design-3d-doc-onshape-${doc.id}`}
            href={onshapeWebUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hud-button"
            style={{
              fontSize: 10,
              letterSpacing: 1.5,
              textDecoration: "none",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            ↗ ONSHAPE
          </a>
        ) : null}
      </div>
    </div>
  );
}

function ElementsPane({
  activeDoc,
  elements,
  loading,
  apiBase,
  onBack,
}: {
  activeDoc: OnshapeDocument;
  elements: OnshapeElement[] | null;
  loading: boolean;
  apiBase: string;
  onBack: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        flex: 1,
      }}
    >
      <button
        type="button"
        data-testid="design-3d-elements-back"
        className="hud-button"
        onClick={onBack}
        style={{ alignSelf: "flex-start", fontSize: 10, letterSpacing: 2 }}
      >
        ← {activeDoc.name.toUpperCase()}
      </button>
      {loading ? (
        <Hint text="Loading elements…" />
      ) : !elements || elements.length === 0 ? (
        <Hint text="This document has no elements yet." />
      ) : (
        <div
          data-testid="design-3d-elements"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            overflowY: "auto",
            flex: 1,
            paddingRight: 4,
          }}
        >
          {elements.map((el) => {
            const url = buildOnshapeUrl(
              apiBase,
              el.document_id,
              el.workspace_id,
              el.id,
            );
            return (
              <a
                key={el.id}
                data-testid={`design-3d-element-${el.id}`}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "8px 10px",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--fg)",
                  textDecoration: "none",
                  transition:
                    "background 140ms ease, border-color 140ms ease",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background =
                    "rgba(108,214,255,0.07)";
                  e.currentTarget.style.borderColor = "var(--orb)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 13,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {el.name}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "var(--muted)",
                      letterSpacing: 1,
                      marginTop: 2,
                    }}
                  >
                    {el.type}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--orb)",
                    letterSpacing: 1.5,
                  }}
                >
                  ↗ OPEN
                </span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NewDocPane({
  name,
  onNameChange,
  onCreate,
  busy,
}: {
  name: string;
  onNameChange: (n: string) => void;
  onCreate: () => void;
  busy: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        flex: 1,
      }}
    >
      <Hint text="Create a blank Onshape document. You can add Part Studios + Assemblies to it once it opens in the real CAD app." />
      <input
        type="text"
        data-testid="design-3d-new-name"
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="Document name (e.g. 'Phone stand v3')"
        style={{
          padding: "10px 12px",
          background: "rgba(8,14,24,0.7)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          color: "var(--fg)",
          fontSize: 14,
          outline: "none",
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !busy) onCreate();
        }}
      />
      <button
        type="button"
        data-testid="design-3d-new-create"
        className="hud-button hud-button--primary"
        onClick={onCreate}
        disabled={busy || name.trim().length === 0}
        style={{ fontSize: 12, letterSpacing: 2 }}
      >
        {busy ? "CREATING…" : "✦ CREATE DOCUMENT"}
      </button>
    </div>
  );
}

function Hint({
  text,
  kind = "muted",
}: {
  text: string;
  kind?: "muted" | "error";
}) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: 0.5,
        lineHeight: 1.6,
        color: kind === "error" ? "var(--danger)" : "var(--muted)",
        background:
          kind === "error" ? "rgba(255,80,80,0.06)" : "transparent",
        border:
          kind === "error" ? "1px solid rgba(255,80,80,0.3)" : "none",
        padding: kind === "error" ? "10px" : "8px 2px",
        borderRadius: 3,
      }}
    >
      {text}
    </div>
  );
}

function CubeHero({ docName }: { docName: string | null }) {
  const caption = docName
    ? `EDITING · ${docName}`
    : "ONSHAPE · PARAMETRIC CAD INTEGRATION";
  // Pre-compute vertex pairs for the 12 edges so rendering stays
  // declarative rather than indexed.
  const edges = useMemo(() => {
    // Cube vertices in NDC (-1..1).
    const v = [
      [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
      [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
    ];
    const idx: ReadonlyArray<[number, number]> = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    return idx.map(([a, b]) => [v[a], v[b]] as const);
  }, []);

  return (
    <div
      data-testid="design-3d-cube"
      style={{
        position: "relative",
        width: 360,
        height: 360,
        animation: "radial-spin-y 14000ms linear infinite",
      }}
    >
      <svg
        viewBox="-2 -2 4 4"
        style={{
          position: "absolute",
          inset: 0,
          filter: "drop-shadow(0 0 18px var(--orb-glow))",
        }}
        aria-hidden
      >
        {edges.map((edge, i) => {
          const [p1, p2] = edge;
          // Cheap orthographic projection — drop Z. The wrapper
          // rotates the whole SVG via CSS so we don't need a real
          // 3D matrix.
          return (
            <line
              key={i}
              x1={p1[0]}
              y1={p1[1]}
              x2={p2[0]}
              y2={p2[1]}
              stroke="var(--orb)"
              strokeWidth={0.06}
              strokeLinecap="round"
              opacity={0.85}
            />
          );
        })}
      </svg>
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
          maxWidth: 720,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {caption}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
