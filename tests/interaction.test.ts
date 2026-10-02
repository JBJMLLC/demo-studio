import { expect, it } from 'vitest';
import { move } from '../src/browser.js';

it('does not accumulate slow protocol steps into a creeping cursor', async () => {
  let now = 0;
  const points: Array<{ x: number; y: number }> = [];
  const page = { mouse: { move: async (x: number, y: number) => { points.push({ x, y }); now += 60; } } };
  await move(page as never, { x: 0, y: 0 }, { x: 600, y: 300 }, 380, { now: () => now, sleep: async (ms) => { now += ms; } });
  expect(points.at(-1)).toEqual({ x: 600, y: 300 });
  expect(points.length).toBeGreaterThan(2);
  expect(points.length).toBeLessThan(15);
  expect(now).toBeLessThanOrEqual(440);
  expect(points.every((point, index) => index === 0 || point.x >= points[index - 1]!.x)).toBe(true);
  expect(points.every((point, index) => point.x - (points[index - 1]?.x ?? 0) < 300)).toBe(true);
});
