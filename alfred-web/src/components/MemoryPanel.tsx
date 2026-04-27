"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteMemoryNote,
  listMemoryNotes,
  type MemoryNote,
  summarizeConversationToMemory,
  updateMemoryNote,
} from "@/lib/api";

interface Props {
  /** Conversation currently active in the chat pane. When set, an
   * "Archive this conversation" action is offered so the user can roll
   * the running chat into long-term memory by hand without dictating
   * the marker into the message stream. */
  activeConversationId: string | null;
}

const SOURCE_LABELS: Record<string, string> = {
  conversation_summary: "ARCHIVED",
  rolling_context: "ROLL-UP",
  manual: "MANUAL",
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const within = now.getTime() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  if (within) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function MemoryPanel({ activeConversationId }: Props) {
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [storagePath, setStoragePath] = useState<string>("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [archivedFlash, setArchivedFlash] = useState<string | null>(null);

  const refresh = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await listMemoryNotes(q);
        setNotes(data.notes);
        setStoragePath(data.storage_path);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void refresh("");
  }, [refresh]);

  // Debounce the search query so each keystroke doesn't slam the
  // backend.
  useEffect(() => {
    const t = setTimeout(() => {
      void refresh(query);
    }, 200);
    return () => clearTimeout(t);
  }, [query, refresh]);

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) ?? null,
    [notes, selectedId],
  );

  useEffect(() => {
    if (selected) {
      setDraftTitle(selected.title);
      setDraftSummary(selected.summary);
    } else {
      setDraftTitle("");
      setDraftSummary("");
      setEditing(false);
    }
  }, [selected]);

  async function archiveActiveConversation() {
    if (!activeConversationId || archiving) return;
    setArchiving(true);
    setError(null);
    try {
      const note = await summarizeConversationToMemory(activeConversationId);
      setArchivedFlash(`Archived: ${note.title}`);
      await refresh(query);
      setSelectedId(note.id);
      setTimeout(() => setArchivedFlash(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  }

  async function saveEdits() {
    if (!selected) return;
    try {
      const updated = await updateMemoryNote(selected.id, {
        title: draftTitle,
        summary: draftSummary,
      });
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeNote(note: MemoryNote) {
    if (
      !window.confirm(
        `Forget "${note.title}"? This deletes the memory note and its Markdown file. Cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await deleteMemoryNote(note.id);
      setNotes((prev) => prev.filter((n) => n.id !== note.id));
      if (selectedId === note.id) setSelectedId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        gap: 8,
        padding: "10px 12px",
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memories…"
          aria-label="Search memory archive"
          style={{
            flex: 1,
            background: "rgba(108, 214, 255, 0.04)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
            borderRadius: 3,
            padding: "5px 8px",
            fontSize: 12,
          }}
        />
        <button
          type="button"
          className="hud-button"
          onClick={() => void refresh(query)}
          title="Refresh memory archive"
          aria-label="Refresh memory archive"
          style={{ padding: "4px 8px", fontSize: 10 }}
        >
          ↻
        </button>
      </div>

      {activeConversationId ? (
        <button
          type="button"
          className="hud-button"
          onClick={archiveActiveConversation}
          disabled={archiving}
          title="Summarise the active conversation into long-term memory"
          style={{
            padding: "4px 10px",
            fontSize: 10,
            letterSpacing: 1.5,
            borderColor: "var(--hud)",
          }}
        >
          {archiving ? "ARCHIVING…" : "+ ARCHIVE THIS CONVERSATION"}
        </button>
      ) : null}

      {archivedFlash ? (
        <div
          style={{
            color: "var(--hud)",
            fontSize: 11,
            fontFamily:
              'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
            padding: "4px 6px",
            borderLeft: "2px solid var(--hud)",
          }}
        >
          {archivedFlash}
        </div>
      ) : null}

      {error ? (
        <div
          style={{
            color: "var(--danger, #ff8a8a)",
            fontSize: 11,
            padding: "4px 6px",
          }}
        >
          {error}
        </div>
      ) : null}

      {!selected ? (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            paddingRight: 4,
          }}
        >
          {loading && notes.length === 0 ? (
            <p
              style={{
                color: "var(--muted)",
                fontSize: 12,
                fontStyle: "italic",
                padding: "8px 4px",
              }}
            >
              Loading memories…
            </p>
          ) : notes.length === 0 ? (
            <p
              style={{
                color: "var(--muted)",
                fontSize: 12,
                fontStyle: "italic",
                padding: "8px 4px",
              }}
            >
              No memories yet. Tell Alfred something worth remembering, or
              archive a past conversation to seed his memory archive.
            </p>
          ) : (
            notes.map((note) => (
              <button
                key={note.id}
                type="button"
                onClick={() => setSelectedId(note.id)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "stretch",
                  gap: 2,
                  padding: "8px 10px",
                  background: "rgba(108, 214, 255, 0.04)",
                  border: "1px solid var(--border)",
                  borderRadius: 3,
                  color: "var(--fg)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {note.title}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--muted)",
                    display: "flex",
                    justifyContent: "space-between",
                    fontFamily:
                      'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
                    letterSpacing: 1,
                  }}
                >
                  <span>
                    {SOURCE_LABELS[note.source] ?? note.source.toUpperCase()}
                  </span>
                  <span>{formatWhen(note.created_at)}</span>
                </span>
                {note.summary ? (
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--muted)",
                      lineHeight: 1.35,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {note.summary}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : (
        <MemoryDetail
          note={selected}
          editing={editing}
          draftTitle={draftTitle}
          draftSummary={draftSummary}
          setDraftTitle={setDraftTitle}
          setDraftSummary={setDraftSummary}
          onBack={() => {
            setSelectedId(null);
            setEditing(false);
          }}
          onEdit={() => setEditing(true)}
          onCancelEdit={() => {
            setDraftTitle(selected.title);
            setDraftSummary(selected.summary);
            setEditing(false);
          }}
          onSave={saveEdits}
          onDelete={() => void removeNote(selected)}
        />
      )}

      {storagePath ? (
        <p
          style={{
            color: "var(--muted)",
            fontSize: 9.5,
            fontFamily:
              'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
            letterSpacing: 1,
            marginTop: "auto",
            paddingTop: 6,
            borderTop: "1px solid var(--border)",
          }}
          title={`Each memory is also written as a Markdown file under ${storagePath}`}
        >
          MIRRORED TO {storagePath}
        </p>
      ) : null}
    </div>
  );
}

function MemoryDetail({
  note,
  editing,
  draftTitle,
  draftSummary,
  setDraftTitle,
  setDraftSummary,
  onBack,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  note: MemoryNote;
  editing: boolean;
  draftTitle: string;
  draftSummary: string;
  setDraftTitle: (v: string) => void;
  setDraftSummary: (v: string) => void;
  onBack: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        paddingRight: 4,
      }}
    >
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button
          type="button"
          className="hud-button"
          onClick={onBack}
          title="Back to memory list"
          aria-label="Back to memory list"
          style={{ padding: "3px 8px", fontSize: 10 }}
        >
          ◀
        </button>
        <span style={{ flex: 1 }} />
        {editing ? (
          <>
            <button
              type="button"
              className="hud-button"
              onClick={onSave}
              title="Save changes"
              style={{ padding: "3px 8px", fontSize: 10 }}
            >
              SAVE
            </button>
            <button
              type="button"
              className="hud-button"
              onClick={onCancelEdit}
              title="Cancel editing"
              style={{ padding: "3px 8px", fontSize: 10 }}
            >
              CANCEL
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="hud-button"
              onClick={onEdit}
              title="Edit this memory"
              style={{ padding: "3px 8px", fontSize: 10 }}
            >
              EDIT
            </button>
            <button
              type="button"
              className="hud-button"
              onClick={onDelete}
              title="Delete this memory"
              style={{
                padding: "3px 8px",
                fontSize: 10,
                color: "var(--danger, #ff8a8a)",
              }}
            >
              DELETE
            </button>
          </>
        )}
      </div>

      {editing ? (
        <input
          type="text"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          aria-label="Memory title"
          style={{
            background: "rgba(108, 214, 255, 0.04)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
            borderRadius: 3,
            padding: "5px 8px",
            fontSize: 14,
            fontWeight: 500,
          }}
        />
      ) : (
        <h3
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 600,
            color: "var(--fg)",
          }}
        >
          {note.title}
        </h3>
      )}

      <div
        style={{
          fontSize: 9.5,
          color: "var(--muted)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
          letterSpacing: 1,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span>{SOURCE_LABELS[note.source] ?? note.source.toUpperCase()}</span>
        <span>CREATED {formatWhen(note.created_at)}</span>
        {note.markdown_filename ? (
          <span title="Filename of the Markdown mirror on disk">
            {note.markdown_filename}
          </span>
        ) : null}
      </div>

      {editing ? (
        <textarea
          value={draftSummary}
          onChange={(e) => setDraftSummary(e.target.value)}
          aria-label="Memory summary"
          rows={6}
          style={{
            background: "rgba(108, 214, 255, 0.04)",
            border: "1px solid var(--border)",
            color: "var(--fg)",
            borderRadius: 3,
            padding: "6px 8px",
            fontSize: 12,
            lineHeight: 1.5,
            resize: "vertical",
            fontFamily: "inherit",
          }}
        />
      ) : (
        <p
          style={{
            margin: 0,
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--fg)",
            whiteSpace: "pre-wrap",
          }}
        >
          {note.summary || (
            <span style={{ fontStyle: "italic", color: "var(--muted)" }}>
              No summary recorded.
            </span>
          )}
        </p>
      )}

      <BulletSection title="KEY FACTS" items={note.key_facts} />
      <BulletSection title="DECISIONS" items={note.decisions} />
      <BulletSection title="FOLLOW-UPS" items={note.follow_ups} />
    </div>
  );
}

function BulletSection({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <h4
        style={{
          margin: 0,
          fontSize: 10,
          letterSpacing: 1.5,
          color: "var(--hud)",
          fontFamily:
            'ui-monospace, SFMono-Regular, "JetBrains Mono", monospace',
        }}
      >
        {title}
      </h4>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          fontSize: 12,
          lineHeight: 1.5,
          color: "var(--fg)",
        }}
      >
        {items.map((item, i) => (
          <li key={`${title}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
