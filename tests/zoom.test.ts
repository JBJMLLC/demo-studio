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
});
