"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { readFileAsChatImage, transcribeAudio, type ChatImage } from "@/lib/api";
import {
  startSilenceDetector,
  type SilenceDetectorHandle,
  type SilenceReason,
} from "@/lib/silenceDetector";
import { orbStore } from "@/lib/orbState";

interface ComposerProps {
  onSend: (text: string, images: ChatImage[]) => Promise<void> | void;
  disabled?: boolean;
  /** Notified whenever mic recording starts/stops. Used by ChatWindow to
   *  pause the wake-word engine while the user is dictating. */
  onMicStateChange?: (recording: boolean) => void;
}

export interface ComposerHandle {
  /** Programmatically start the voice-recording flow (e.g. from a wake
   *  word). No-op if already recording, transcribing, or disabled. */
  startVoice: () => void;
  /** Attach an image to the composer (e.g. a webcam snapshot from the
   *  "Look" button). The image counts against MAX_IMAGES; if the
   *  attachment would exceed the cap, the oldest images are dropped to
   *  make room — matching how the manual paperclip handles overflow.
   *  Returns true if attached, false if rejected. */
  attachImage: (
    image: ChatImage & { label?: string },
  ) => boolean;
  /** Move keyboard focus to the text input. Used by the
   *  Quick-Tools "Keyboard" item so the user can hand off from
   *  hand-tracking to physical typing without grabbing the mouse. */
  focus: () => void;
}

type MicState = "idle" | "recording" | "transcribing";

interface AttachedImage extends ChatImage {
  /** Stable id used for React keys + remove buttons. */
  id: string;
  /** Object URL for the thumbnail preview. Revoked when removed. */
  previewUrl: string;
  /** Display label (filename or "Pasted image"). */
  label: string;
}

const ALLOWED_MIME = /^image\/(png|jpe?g|gif|webp)$/;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSend, disabled, onMicStateChange },
  ref,
) {
  const [text, setText] = useState("");
  const [mic, setMic] = useState<MicState>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const silenceDetectorRef = useRef<SilenceDetectorHandle | null>(null);
  // Reason the recorder stopped, captured from the silence detector so
  // the ``onstop`` handler can tailor the user-facing error (e.g. show
  // a "didn't hear anything" message on a no-speech timeout, but
  // proceed to transcription on a normal trailing-silence stop).
  const stopReasonRef = useRef<SilenceReason | "manual" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Mirror of `images` state for the unmount cleanup. The cleanup runs
  // exactly once with the dependency-array-captured value, which would be
  // the empty initial state — using a ref keeps it pointing at the live
  // attachments so we revoke real object URLs on unmount.
  const imagesRef = useRef<AttachedImage[]>([]);
  imagesRef.current = images;
  // Same pattern for `onSend`: when the wake word fires, recorder.onstop
  // runs with whatever closure was captured the first time the recording
  // started — but `handleSend` in the parent closes over `convoId`,
  // `voiceOut`, etc. which change over the conversation's lifetime. Read
  // through the ref so wake-word voice messages always land on the
  // current conversation with the latest voice-out preference.
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  useEffect(() => {
    return () => {
      // Cleanup if the user navigates away mid-recording.
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") rec.stop();
    };
  }, []);

  // Revoke object URLs on unmount so we don't leak memory if the user
  // attaches images and then navigates away without sending. Per-image
  // cleanup for the normal send/remove paths happens inline in submit
  // and removeImage.
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    };
  }, []);

  async function ingestFiles(files: FileList | File[], origin: "picker" | "paste" | "drop") {
    setImageError(null);
    const incoming = Array.from(files).filter((f) => f.size > 0);
    if (incoming.length === 0) return;

    if (images.length + incoming.length > MAX_IMAGES) {
      setImageError(
        `You can attach up to ${MAX_IMAGES} images per message; that would be ${images.length + incoming.length}.`,
      );
      return;
    }

    const accepted: AttachedImage[] = [];
    for (const file of incoming) {
      if (!ALLOWED_MIME.test(file.type)) {
        setImageError(
          `${file.name || "That file"} isn't an image type Alfred supports (PNG, JPEG, GIF, WebP).`,
        );
        continue;
      }
      if (file.size > MAX_BYTES) {
        setImageError(
          `${file.name || "That image"} is over the 5 MB limit.`,
        );
        continue;
      }
      try {
        const encoded = await readFileAsChatImage(file);
        const previewUrl = URL.createObjectURL(file);
        const label =
          origin === "paste" && !file.name ? "Pasted image" : file.name || "Image";
        accepted.push({
          ...encoded,
          id: crypto.randomUUID(),
          previewUrl,
          label,
        });
      } catch (err) {
        setImageError(
          err instanceof Error ? err.message : "Could not read that image.",
        );
      }
    }
    if (accepted.length > 0) {
      setImages((prev) => [...prev, ...accepted]);
    }
  }

  function removeImage(id: string) {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((img) => img.id !== id);
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (disabled) return;
    // Either text or at least one image is required — empty submissions
    // would be rejected by the backend.
    if (!trimmed && images.length === 0) return;
    const payload: ChatImage[] = images.map(({ data, mime_type }) => ({
      data,
      mime_type,
    }));
    // Snapshot what we need to clean up, then clear local state, then
    // hand off to the parent so the bubble shows the user's message + images
    // immediately.
    const toRevoke = images.map((img) => img.previewUrl);
    setText("");
    setImages([]);
    setImageError(null);
    try {
      await onSend(trimmed, payload);
    } finally {
      for (const url of toRevoke) URL.revokeObjectURL(url);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit(e as unknown as FormEvent);
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && ALLOWED_MIME.test(file.type)) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void ingestFiles(files, "paste");
    }
  }

  function onDragOver(e: DragEvent<HTMLFormElement>) {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      setIsDragging(true);
    }
  }

  function onDragLeave(e: DragEvent<HTMLFormElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  }

  function onDrop(e: DragEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) void ingestFiles(files, "drop");
  }

  // Mirror the latest mic state for the imperative startVoice handler.
  // Without this, the closure baked into useImperativeHandle would always
  // see "idle" even after the user starts a recording from the wake word.
  const micRef = useRef<MicState>(mic);
  micRef.current = mic;
  const disabledRef = useRef<boolean>(Boolean(disabled));
  disabledRef.current = Boolean(disabled);
  // Synchronous lock for the async window inside startRecording: between
  // the call to startRecording() and `await getUserMedia()` resolving,
  // micRef is still "idle". Without this, two wake-word firings in quick
  // succession (e.g. while the mic-permission prompt is open) would each
  // pass the micRef guard, spawning two MediaRecorder instances and
  // orphaning the first one's stream.
  const startingRef = useRef<boolean>(false);

  // Notify the parent whenever recording starts or stops so it can pause
  // wake-word listening (otherwise we'd race the user's own voice).
  // Also publishes mic-recording state to the orb store so the JARVIS
  // orb pulses with mic RMS while the user is dictating.
  useEffect(() => {
    onMicStateChange?.(mic === "recording");
    orbStore.setHold("listening", mic === "recording");
    return () => {
      // If the component unmounts mid-recording, make sure both the
      // orb store and the parent's ``recording`` state are cleared —
      // otherwise ChatWindow would keep the wake-word engine paused
      // and the orb caption stuck on "Listening" until the Composer
      // remounted. With the sidebar layout the Composer normally
      // stays mounted across tab/collapse toggles (see the stable
      // chat-pane slot in ConversationSidebar), but this cleanup
      // is the safety net for any future remount path.
      orbStore.setHold("listening", false);
      onMicStateChange?.(false);
    };
  }, [mic, onMicStateChange]);

  async function startRecording() {
    if (startingRef.current) return;
    startingRef.current = true;
    setMicError(null);
    stopReasonRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      // Auto-stop on silence: monitor the live RMS of the same stream
      // we're recording from. The detector only signals once; ``stop``
      // is also called from the recorder's ``onstop`` handler below as
      // belt-and-braces in case the manual stop button is clicked.
      silenceDetectorRef.current = startSilenceDetector({
        stream,
        onLevel: (rms) => orbStore.pushLevel(rms),
        onSilence: (reason) => {
          // ``stop`` may already have been called from elsewhere (the
          // manual button, or this very callback running after the
          // recorder transitioned to inactive). Guard so we don't
          // double-fire.
          if (stopReasonRef.current === null) {
            stopReasonRef.current = reason;
          }
          const rec = recorderRef.current;
          if (rec && rec.state !== "inactive") rec.stop();
        },
      });
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (silenceDetectorRef.current) {
          silenceDetectorRef.current.stop();
          silenceDetectorRef.current = null;
        }
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        chunksRef.current = [];
        const stopReason = stopReasonRef.current;
        stopReasonRef.current = null;
        if (stopReason === "no_speech") {
          // Silence detector gave up before hearing any speech. Don't
          // bother transcribing an empty buffer.
          setMicError(
            "I didn't hear anything. Try again, a touch closer to the mic.",
          );
          setMic("idle");
          return;
        }
        if (blob.size === 0) {
          setMicError(
            "I didn't pick up any audio. Check that your microphone is selected in Windows Sound settings.",
          );
          setMic("idle");
          return;
        }
        setMic("transcribing");
        try {
          const transcript = await transcribeAudio(blob);
          const cleaned = transcript.trim();
          if (cleaned) {
            // Read from the ref, not the captured `images` state — the
            // user may have added or removed attachments while recording.
            const live = imagesRef.current;
            const payload: ChatImage[] = live.map(({ data, mime_type }) => ({
              data,
              mime_type,
            }));
            const toRevoke = live.map((img) => img.previewUrl);
            setText("");
            setImages([]);
            setImageError(null);
            try {
              // Read through onSendRef so wake-word triggered messages
              // always see the current `convoId` / `voiceOut` from the
              // parent — not whatever was captured at first render.
              await onSendRef.current(cleaned, payload);
            } finally {
              for (const url of toRevoke) URL.revokeObjectURL(url);
            }
          } else {
            setMicError(
              "I couldn't make out any words. Try speaking a bit louder or closer to the mic.",
            );
          }
        } catch (err) {
          setMicError(err instanceof Error ? err.message : "Transcription failed");
        } finally {
          setMic("idle");
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      setMic("recording");
    } catch (err) {
      // If we set up the silence detector before the throw (e.g. an
      // exception inside ``recorder.start()``), make sure we tear it
      // down so its AudioContext doesn't leak.
      if (silenceDetectorRef.current) {
        silenceDetectorRef.current.stop();
        silenceDetectorRef.current = null;
      }
      setMicError(
        err instanceof Error
          ? `Microphone unavailable: ${err.message}`
          : "Microphone unavailable",
      );
      setMic("idle");
    } finally {
      startingRef.current = false;
    }
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (!rec || rec.state === "inactive") return;
    if (stopReasonRef.current === null) {
      stopReasonRef.current = "manual";
    }
    // Tear down the silence detector eagerly so it doesn't fire a
    // spurious "trailing_silence" between this call and the recorder's
    // onstop handler running.
    if (silenceDetectorRef.current) {
      silenceDetectorRef.current.stop();
      silenceDetectorRef.current = null;
    }
    rec.stop();
  }

  function toggleMic() {
    if (mic === "recording") stopRecording();
    else if (mic === "idle") void startRecording();
  }

  // We deliberately don't list `startRecording` in the dependency array.
  // It's a stable closure within this component and the imperative handle
  // gates on `disabledRef` and `micRef`, both of which read live values.
  // Recreating the handle on every render would needlessly rebuild it for
  // every parent state change.
  useImperativeHandle(
    ref,
    () => ({
      startVoice: () => {
        if (disabledRef.current) return;
        if (micRef.current !== "idle") return;
        if (startingRef.current) return;
        void startRecording();
      },
      focus: () => {
        textareaRef.current?.focus();
      },
      attachImage: (img) => {
        if (disabledRef.current) return false;
        const attached: AttachedImage = {
          data: img.data,
          mime_type: img.mime_type,
          id: crypto.randomUUID(),
          // Webcam snapshots don't have a File backing them, so build a
          // data URL preview directly from the bytes we already have.
          previewUrl: `data:${img.mime_type};base64,${img.data}`,
          label: img.label ?? "Webcam snapshot",
        };
        setImages((prev) => {
          // Drop the oldest images if we'd exceed the cap, to mirror
          // how the user would expect a fresh capture to slot in.
          const next = [...prev, attached];
          while (next.length > MAX_IMAGES) {
            const removed = next.shift();
            if (removed) URL.revokeObjectURL(removed.previewUrl);
          }
          return next;
        });
        return true;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const micBusy = mic !== "idle";
  const micLabel =
    mic === "recording"
      ? "Stop recording"
      : mic === "transcribing"
        ? "Transcribing…"
        : "Speak to Alfred";
  const micGlyph = mic === "recording" ? "■" : mic === "transcribing" ? "…" : "🎙";

  const canSubmit = !disabled && !micBusy && (text.trim().length > 0 || images.length > 0);

  // Visual state for the mic button: solid red+pulsing when actively
  // recording, plain HUD when idle/transcribing.
  const micBtnClass =
    mic === "recording"
      ? "hud-button hud-button--recording"
      : "hud-button";

  return (
    <form
      onSubmit={submit}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 0",
        borderTop: "1px solid var(--border)",
        background: isDragging
          ? "rgba(108, 214, 255, 0.05)"
          : "transparent",
        transition: "background 120ms ease",
      }}
    >
      {images.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            paddingBottom: 4,
          }}
        >
          {images.map((img) => (
            <div
              key={img.id}
              style={{
                position: "relative",
                width: 64,
                height: 64,
                borderRadius: 3,
                overflow: "hidden",
                border: "1px solid var(--border)",
                background: "var(--bg-elev)",
                boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.02)",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.previewUrl}
                alt={img.label}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                aria-label={`Remove ${img.label}`}
                title={`Remove ${img.label}`}
                style={{
                  position: "absolute",
                  top: 2,
                  right: 2,
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  border: "none",
                  background: "rgba(0, 0, 0, 0.7)",
                  color: "#fff",
                  fontSize: 12,
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <button
          type="button"
          className={micBtnClass}
          onClick={toggleMic}
          disabled={disabled || mic === "transcribing"}
          aria-label={micLabel}
          title={micLabel}
          style={{
            minWidth: 52,
            justifyContent: "center",
            fontSize: 16,
            letterSpacing: 0,
          }}
        >
          {micGlyph}
        </button>

        <button
          type="button"
          className="hud-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || micBusy || images.length >= MAX_IMAGES}
          aria-label="Attach an image"
          title="Attach an image (or paste / drop one)"
          style={{
            minWidth: 52,
            justifyContent: "center",
            fontSize: 16,
            letterSpacing: 0,
          }}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) void ingestFiles(e.target.files, "picker");
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
          }}
        />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={
            mic === "recording"
              ? "Listening…"
              : mic === "transcribing"
                ? "Transcribing your message…"
                : isDragging
                  ? "Drop your image here…"
                  : 'Say "Hello Alfred" — or hit the mic, or attach an image.'
          }
          rows={2}
          disabled={disabled || micBusy}
          className="hud-textarea"
          // Native vertical resize handle on the bottom-right corner
          // — drag it to give yourself room for longer messages.
          // Bounded so the textarea can't eat the entire viewport.
          style={{
            flex: 1,
            resize: "vertical",
            minHeight: 44,
            maxHeight: "60vh",
            padding: "10px 12px",
            borderRadius: 3,
            border: "1px solid var(--border)",
            background: "var(--bg-elev)",
            color: "var(--fg)",
            fontSize: 15,
            fontFamily: "inherit",
            outline: "none",
            transition: "border-color 160ms ease, box-shadow 160ms ease",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--hud)";
            e.currentTarget.style.boxShadow =
              "0 0 0 1px var(--hud), 0 0 14px var(--orb-glow)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--border)";
            e.currentTarget.style.boxShadow = "none";
          }}
        />
        <button
          type="submit"
          className="hud-button hud-button--primary"
          disabled={!canSubmit}
          style={{
            minWidth: 86,
            justifyContent: "center",
            fontSize: 12,
          }}
        >
          SEND ▸
        </button>
      </div>
      {micError && (
        <div style={{ color: "var(--danger)", fontSize: 12 }}>{micError}</div>
      )}
      {imageError && (
        <div style={{ color: "var(--danger)", fontSize: 12 }}>{imageError}</div>
      )}
    </form>
  );
});
