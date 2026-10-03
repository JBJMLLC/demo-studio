import { afterEach, expect, it, vi } from 'vitest';
import { renderWithProtocolSafeLogs } from '../src/render.js';

afterEach(() => vi.restoreAllMocks());

it('keeps Remotion first-download, composition, and render progress logs off MCP stdout', async () => {
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const levels: Array<string | undefined> = [];
  const emitRemotionInfo = (level: string | undefined, line: string) => {
    levels.push(level);
    // Remotion Log.info uses console.log when its effective level is info.
    if (level !== 'error') console.log(line);
  };
  const api = {
    ensureBrowser: async (options?: { logLevel?: string }) => emitRemotionInfo(options?.logLevel, 'Downloading Chrome Headless Shell'),
    selectComposition: async (options: { logLevel?: string }) => {
      emitRemotionInfo(options.logLevel, 'Selecting composition');
      return {};
    },
    renderMedia: async (options: { logLevel?: string }) => emitRemotionInfo(options.logLevel, 'Rendering frames'),
  } as unknown as Parameters<typeof renderWithProtocolSafeLogs>[0];

  await renderWithProtocolSafeLogs(api, {
    serveUrl: 'http://127.0.0.1:3000',
    id: 'Demo',
    codec: 'h264',
    outputLocation: '/tmp/demo.mp4',
    inputProps: {},
    concurrency: 2,
    overwrite: true,
  });

  expect(levels).toEqual(['error', 'error', 'error']);
  expect(stdout).not.toHaveBeenCalled();
});
