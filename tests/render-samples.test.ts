import { expect, it } from 'vitest';
import { sampleTimes } from '../src/render.js';

it('never samples a review frame at or past the end of the video', () => {
  // A 74.005 s container whose video ends at 74.000 s: the 2 s grid used to add 74000, ffmpeg
  // wrote no frame for it, and the render failed with "Artifact file is missing or inaccessible".
  const samples = sampleTimes(74_005, { events: [{ atMs: 73_800 }] as never, scenes: [{ endMs: 74_005 }] as never });
  expect(Math.max(...samples)).toBe(73_905);
  expect(samples).toContain(72_000);
  expect(samples).not.toContain(74_000);
  expect(samples[0]).toBe(0);
});
