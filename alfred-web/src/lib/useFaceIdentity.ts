"use client";

/**
 * useFaceIdentity — single source of truth for "who's in front of
 * the camera right now".
 *
 * Polls ``/vision/face/identify`` every ~1.5 s with the current
 * face identity vector. Applies sticky-vote logic (2 consecutive
 * polls must agree) so a single bad frame doesn't flicker the
 * displayed name.
 *
 * Exposes:
 *   - ``match``    — best enrollment match or null
 *   - ``isAdmin``  — true if the current match is flagged
 *                    ``is_admin`` in its enrollment metadata. Used
 *                    by the Nightfall protocol to gate the toggle
 *                    behind admin face presence.
 *   - ``displayName`` — convenience string ("Mukarram", "Unknown
 *                       face", or null when no face)
 *
 * Lives at ChatWindow scope so multiple consumers (camera-preview
 * label, FaceRecognitionWidget, Nightfall guard) share a single
 * polling loop instead of duplicating identify requests.
 */

import { useEffect, useRef, useState } from "react";
import type { FaceState } from "@/lib/useFaceTracking";
import {
  identifyFace,
  type FaceIdentifyResponse,
  type FaceEnrollment,
} from "@/lib/visionApi";

const IDENTIFY_INTERVAL_MS = 1500;
const STICKY_VOTE_THRESHOLD = 2;

function matchKey(res: FaceIdentifyResponse | null): string {
  if (!res) return "__none__";
  if (!res.match) return "__unknown__";
  return res.match.enrollment.id;
}

export interface FaceIdentityState {
  /** Most recent committed identify response. */
  identity: FaceIdentifyResponse | null;
  /** Convenience — best match or null. */
  match: FaceIdentifyResponse["match"];
  /** Whether the matched enrollment carries the ``is_admin`` flag.
   *  When ``false`` (or no match) the Nightfall guard refuses to
   *  let the user enter Nightfall mode by voice. */
  isAdmin: boolean;
  /** Display label for HUD overlays. */
  displayName: string | null;
}

interface Options {
  face: FaceState | null;
  faceStatus: "off" | "starting" | "ready" | "error";
  /** When ``false`` we don't poll the backend (camera off / between
   *  reconnects). Saves request volume + battery. */
  enabled: boolean;
}

export function useFaceIdentity({
  face,
  faceStatus,
  enabled,
}: Options): FaceIdentityState {
  const [identity, setIdentity] = useState<FaceIdentifyResponse | null>(null);
  const lastIdentifyAt = useRef(0);
  const pendingMatchRef = useRef<{
    key: string;
    candidate: FaceIdentifyResponse | null;
    count: number;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !face || faceStatus !== "ready") return;
    const now = performance.now();
    if (now - lastIdentifyAt.current < IDENTIFY_INTERVAL_MS) return;
    lastIdentifyAt.current = now;
    void (async () => {
      try {
        const res = await identifyFace(face.identityVector);
        const currentKey = matchKey(identity);
        const incomingKey = matchKey(res);
        if (incomingKey === currentKey) {
          setIdentity(res);
          pendingMatchRef.current = null;
          return;
        }
        const pending = pendingMatchRef.current;
        if (pending && pending.key === incomingKey) {
          pending.count += 1;
          pending.candidate = res;
          if (pending.count >= STICKY_VOTE_THRESHOLD) {
            setIdentity(res);
            pendingMatchRef.current = null;
          }
        } else {
          pendingMatchRef.current = {
            key: incomingKey,
            candidate: res,
            count: 1,
          };
        }
      } catch {
        /* backend offline — stay silent */
      }
    })();
  }, [face, faceStatus, identity, enabled]);

  // When the camera goes off, drop the cached identity so a new
  // session starts from scratch (otherwise the name would linger
  // for a moment when the user opens the camera again).
  useEffect(() => {
    if (!enabled) {
      setIdentity(null);
      pendingMatchRef.current = null;
    }
  }, [enabled]);

  const match = identity?.match ?? null;
  const enrollment = match?.enrollment as
    | (FaceEnrollment & { is_admin?: boolean | null })
    | undefined;
  const isAdmin = Boolean(enrollment?.is_admin);
  const displayName = !face
    ? null
    : match
      ? match.enrollment.name
      : "Unknown face";

  return { identity, match, isAdmin, displayName };
}
