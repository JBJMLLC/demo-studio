import { describe, expect, it } from 'vitest';
import { planZoom, zoomAt } from '../src/zoom.js';

const fps = 30;
const click = (atMs: number, x: number, y: number) => ({ type: 'click', atMs, endMs: atMs + 150, cursor: { x, y } });

describe('interaction zoom', () => {
  it('pans between nearby actions instead of zooming out and back in', () => {
    const windows = planZoom([click(2_000, 100, 100), click(3_500, 900, 500), click(12_000, 400, 300)], fps, 600);
    expect(windows).toHaveLength(2);
    expect(windows[0].foci.map((focus) => focus.x)).toEqual([100, 900]);
  });

  it('ignores waits, navigation and actions without a cursor position', () => {
    expect(planZoom([{ type: 'wait', atMs: 1_000, endMs: 2_000, cursor: { x: 1, y: 1 } }, { type: 'click', atMs: 3_000, cursor: null }], fps, 300)).toEqual([]);
  });

  it('reaches full zoom on the action and never shows past the recording edges', () => {
    const windows = planZoom([click(2_000, 10, 10)], fps, 300);
    const view = zoomAt(60, windows, 2, 1920, 1080, fps);
    expect(view).toEqual({ scale: 2, left: 0, top: 0 });
    expect(zoomAt(0, windows, 2, 1920, 1080, fps).scale).toBe(1);
    expect(zoomAt(60, windows, 1, 1920, 1080, fps)).toEqual({ scale: 1, left: 0, top: 0 });
  });

  describe('focus moments', () => {
    const viewport = { width: 1920, height: 1080 };
    const focus = (atMs: number, extra: Record<string, unknown> = {}) => ({ type: 'focus', atMs, endMs: atMs, cursor: { x: 5, y: 5 }, target: { x: 800, y: 400, width: 320, height: 200 }, ...extra });

    it('eases in before the anchor, aims at the target box and holds for the authored duration', () => {
      const [window, ...rest] = planZoom([focus(4_000, { holdMs: 3_000 })], fps, 600, viewport, 2);
      expect(rest).toEqual([]);
      expect(window.foci).toEqual([{ panStartFrame: 102, x: 960, y: 500, scale: 2 }]);
      // Eases in 600 ms before the anchor, holds 3 s, eases out over 600 ms.
      expect(window.startFrame).toBe(Math.round((4_000 - 600) * fps / 1000));
      expect(window.endFrame).toBe(Math.round((4_000 + 3_000 + 600) * fps / 1000));
      expect(zoomAt(window.startFrame, [window], 2, 1920, 1080, fps).scale).toBe(1);
      expect(zoomAt(Math.round(4_000 * fps / 1000), [window], 2, 1920, 1080, fps).scale).toBe(2);
      expect(zoomAt(Math.round(6_900 * fps / 1000), [window], 2, 1920, 1080, fps).scale).toBe(2);
      expect(zoomAt(window.endFrame, [window], 2, 1920, 1080, fps).scale).toBe(1);
    });

    it('holds until the next action when no duration is authored', () => {
      const [window] = planZoom([focus(2_000), focus(5_000, { target: { x: 100, y: 100, width: 200, height: 100 } })], fps, 900, viewport, 2);
      expect(window.foci).toHaveLength(2);
      const [alone] = planZoom([focus(2_000), click(5_000, 10, 10)], fps, 900, viewport, 2);
      expect(alone.foci.map((entry) => entry.x)).toEqual([960, 10]);
      // Held through to the click rather than easing out after a default hold.
      expect(zoomAt(Math.round(4_000 * fps / 1000), [alone], 2, 1920, 1080, fps).scale).toBe(2);
    });

    it('does not zoom in past what keeps the target box in frame, but an explicit level wins', () => {
      const wide = { x: 100, y: 100, width: 1500, height: 300 };
      expect(planZoom([focus(2_000, { target: wide })], fps, 600, viewport, 3)[0].foci[0].scale).toBeCloseTo(1920 / 1500 * 0.85);
      expect(planZoom([focus(2_000, { target: wide, zoom: 2.5 })], fps, 600, viewport, 3)[0].foci[0].scale).toBe(2.5);
    });

    it('skips an action with zoom false, focus or click', () => {
      expect(planZoom([focus(2_000, { zoom: false }), { ...click(8_000, 1, 1), zoom: false }], fps, 600, viewport, 2)).toEqual([]);
    });

    it('pans from a neighbouring click and eases the level between them', () => {
      const windows = planZoom([click(2_000, 100, 100), focus(4_000, { holdMs: 1_000, target: { x: 1400, y: 700, width: 400, height: 300 }, zoom: 1.5 })], fps, 600, viewport, 2);
      expect(windows).toHaveLength(1);
      expect(windows[0].foci.map((entry) => entry.scale)).toEqual([undefined, 1.5]);
      const end = zoomAt(Math.round(5_000 * fps / 1000), windows, 2, 1920, 1080, fps);
      expect(end.scale).toBeCloseTo(1.5);
      const mid = zoomAt(Math.round(3_000 * fps / 1000), windows, 2, 1920, 1080, fps);
      expect(mid.scale).toBe(2);
    });

    it('ignores a focus without a target box and, at plan zoom 1, never zooms', () => {
      expect(planZoom([{ type: 'focus', atMs: 1_000, cursor: null }], fps, 300, viewport, 2)).toEqual([]);
      const windows = planZoom([focus(2_000)], fps, 300, viewport, 1);
      expect(zoomAt(75, windows, 1, 1920, 1080, fps)).toEqual({ scale: 1, left: 0, top: 0 });
    });
  });
});
