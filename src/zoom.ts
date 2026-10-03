// Camera zoom toward interactions. Pure frame math shared by the render step (which
// plans the windows) and the composition (which applies them), so both agree.

/** `scale` is this focus's own zoom level; absent means the plan-level scale. */
export type ZoomFocus = { panStartFrame: number; x: number; y: number; scale?: number };
export type ZoomWindow = { startFrame: number; endFrame: number; foci: ZoomFocus[] };
export type ZoomBox = { x: number; y: number; width: number; height: number };
export type ZoomEvent = {
  type: string; atMs: number; endMs?: number; cursor?: { x: number; y: number } | null;
  /** Focus events: the target's box, the authored hold (absent = until the next event) and the per-action zoom. */
  target?: ZoomBox; holdMs?: number; zoom?: false | number;
};
export type ZoomView = { scale: number; left: number; top: number };

const ZOOMED_TYPES = new Set(['click', 'type', 'drag', 'focus']);
// A focus has no cursor to travel, so it only eases in ahead of its anchor.
const FOCUS_LEAD_MS = 600;
const FOCUS_DEFAULT_HOLD_MS = 2_000;
const FOCUS_MAX_IMPLICIT_HOLD_MS = 10_000;
// Share of the frame a focused box may fill before the camera stops zooming in.
const FOCUS_FILL = 0.85;
// The cursor travels and hovers for ~700ms before an action lands; be fully zoomed by then.
const LEAD_MS = 1_100;
const RAMP_MS = 600;
const HOLD_AFTER_MS = 1_000;
const PAN_MS = 600;

const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/**
 * Groups nearby interactions into zoom windows; the camera pans between foci inside one window.
 * `plan` is the plan-level zoom (1 = off) and `viewport` lets a focus fit its target box.
 */
export function planZoom(events: ZoomEvent[], fps: number, durationInFrames: number, viewport?: { width: number; height: number }, plan = 2): ZoomWindow[] {
  const toFrame = (ms: number) => Math.round(ms * fps / 1000);
  const windows: ZoomWindow[] = [];
  const sorted = [...events].sort((a, b) => a.atMs - b.atMs);
  sorted.forEach((event, index) => {
    if (!ZOOMED_TYPES.has(event.type) || event.zoom === false) return;
    let x: number, y: number, scale: number | undefined, startMs: number, endMs: number;
    if (event.type === 'focus') {
      if (!event.target) return;
      const box = event.target;
      x = box.x + box.width / 2; y = box.y + box.height / 2;
      // An explicit level is used as written; otherwise zoom in as far as the plan allows while keeping the box in frame.
      const fit = viewport ? Math.min(viewport.width / box.width, viewport.height / box.height) * FOCUS_FILL : plan;
      scale = event.zoom ?? Math.max(1, Math.min(plan, fit));
      const next = sorted.slice(index + 1).find((entry) => entry.atMs > event.atMs);
      const hold = event.holdMs ?? (next ? Math.min(next.atMs - event.atMs, FOCUS_MAX_IMPLICIT_HOLD_MS) : FOCUS_DEFAULT_HOLD_MS);
      startMs = event.atMs - FOCUS_LEAD_MS;
      endMs = event.atMs + hold + RAMP_MS;
    } else {
      if (!event.cursor) return;
      x = event.cursor.x; y = event.cursor.y; scale = event.zoom || undefined;
      startMs = event.atMs - LEAD_MS;
      endMs = (event.endMs ?? event.atMs) + HOLD_AFTER_MS + RAMP_MS;
    }
    const startFrame = Math.max(0, toFrame(startMs));
    const endFrame = Math.min(durationInFrames, toFrame(endMs));
    const focus: ZoomFocus = { panStartFrame: startFrame, x, y, ...(scale !== undefined ? { scale } : {}) };
    const previous = windows.at(-1);
    // Zooming out and straight back in reads as jitter; pan instead.
    if (previous && startFrame <= previous.endFrame + toFrame(RAMP_MS)) {
      previous.endFrame = Math.max(previous.endFrame, endFrame);
      previous.foci.push(focus);
    } else {
      windows.push({ startFrame, endFrame, foci: [focus] });
    }
  });
  return windows;
}

/** Visible region of the recording at a frame, in recording pixels. */
export function zoomAt(frame: number, windows: ZoomWindow[], maxScale: number, width: number, height: number, fps: number): ZoomView {
  const window = windows.find((entry) => frame >= entry.startFrame && frame < entry.endFrame);
  if (!window || maxScale <= 1) return { scale: 1, left: 0, top: 0 };
  const ramp = RAMP_MS * fps / 1000;
  const amount = Math.min(smooth((frame - window.startFrame) / ramp), smooth((window.endFrame - frame) / ramp));
  let index = 0;
  while (index + 1 < window.foci.length && window.foci[index + 1].panStartFrame <= frame) index++;
  const current = window.foci[index];
  const previous = window.foci[Math.max(0, index - 1)];
  const pan = index === 0 ? 1 : smooth((frame - current.panStartFrame) / (PAN_MS * fps / 1000));
  // Each focus may carry its own level; ease between neighbours like the position.
  const from = previous.scale ?? maxScale, to = current.scale ?? maxScale;
  const scale = 1 + (from + (to - from) * pan - 1) * amount;
  const cx = previous.x + (current.x - previous.x) * pan;
  const cy = previous.y + (current.y - previous.y) * pan;
  const viewWidth = width / scale;
  const viewHeight = height / scale;
  // Clamp so the camera never shows past the recording's edges.
  return {
    scale,
    left: Math.min(Math.max(cx - viewWidth / 2, 0), width - viewWidth),
    top: Math.min(Math.max(cy - viewHeight / 2, 0), height - viewHeight),
  };
}
