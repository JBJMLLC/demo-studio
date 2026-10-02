// Camera zoom toward interactions. Pure frame math shared by the render step (which
// plans the windows) and the composition (which applies them), so both agree.

export type ZoomFocus = { panStartFrame: number; x: number; y: number };
export type ZoomWindow = { startFrame: number; endFrame: number; foci: ZoomFocus[] };
export type ZoomEvent = { type: string; atMs: number; endMs?: number; cursor?: { x: number; y: number } | null };
export type ZoomView = { scale: number; left: number; top: number };

const ZOOMED_TYPES = new Set(['click', 'type', 'drag']);
// The cursor travels and hovers for ~700ms before an action lands; be fully zoomed by then.
const LEAD_MS = 1_100;
const RAMP_MS = 600;
const HOLD_AFTER_MS = 1_000;
const PAN_MS = 600;

const smooth = (t: number) => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };

/** Groups nearby interactions into zoom windows; the camera pans between foci inside one window. */
export function planZoom(events: ZoomEvent[], fps: number, durationInFrames: number): ZoomWindow[] {
  const toFrame = (ms: number) => Math.round(ms * fps / 1000);
  const windows: ZoomWindow[] = [];
  for (const event of [...events].sort((a, b) => a.atMs - b.atMs)) {
    if (!ZOOMED_TYPES.has(event.type) || !event.cursor) continue;
    const startFrame = Math.max(0, toFrame(event.atMs - LEAD_MS));
    const endFrame = Math.min(durationInFrames, toFrame((event.endMs ?? event.atMs) + HOLD_AFTER_MS + RAMP_MS));
    const focus = { panStartFrame: startFrame, x: event.cursor.x, y: event.cursor.y };
    const previous = windows.at(-1);
    // Zooming out and straight back in reads as jitter; pan instead.
    if (previous && startFrame <= previous.endFrame + toFrame(RAMP_MS)) {
      previous.endFrame = Math.max(previous.endFrame, endFrame);
      previous.foci.push(focus);
    } else {
      windows.push({ startFrame, endFrame, foci: [focus] });
    }
  }
  return windows;
}

/** Visible region of the recording at a frame, in recording pixels. */
export function zoomAt(frame: number, windows: ZoomWindow[], maxScale: number, width: number, height: number, fps: number): ZoomView {
  const window = windows.find((entry) => frame >= entry.startFrame && frame < entry.endFrame);
  if (!window || maxScale <= 1) return { scale: 1, left: 0, top: 0 };
  const ramp = RAMP_MS * fps / 1000;
  const amount = Math.min(smooth((frame - window.startFrame) / ramp), smooth((window.endFrame - frame) / ramp));
  const scale = 1 + (maxScale - 1) * amount;
  let index = 0;
  while (index + 1 < window.foci.length && window.foci[index + 1].panStartFrame <= frame) index++;
  const current = window.foci[index];
  const previous = window.foci[Math.max(0, index - 1)];
  const pan = index === 0 ? 1 : smooth((frame - current.panStartFrame) / (PAN_MS * fps / 1000));
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
