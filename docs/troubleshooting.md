# Troubleshooting

## `doctor` reports a missing browser

Install Chromium with `npx playwright install chromium`, then rebuild and rerun `node dist/cli.js doctor`. If your environment restricts browser downloads, use an already-installed supported browser only if the runtime explicitly reports it as available.

## The example URL does not load

Keep `npm run example` running in its own terminal. The default URL is `http://127.0.0.1:4399`; if that port is in use, set `PORT` to an available port and update `targetUrl` in a copy of the plan. Do not bind the demo fixture to a public interface.

## Navigation or a browser request is blocked

The built-in browser adapter requires the exact canonical `targetUrl`: it blocks same-origin and cross-origin redirects, external HTTP(S)/WebSocket requests, service workers, and popups. Update the plan to the direct URL that serves the page, and keep required assets on that origin. If the application depends on a CDN, external sign-in, redirect, or streaming origin, stop using the built-in adapter for that flow and implement a separately reviewed custom `BrowserAdapter`; do not work around the boundary by relaxing browser isolation.

## Media tools are missing

Install FFmpeg and `ffprobe` using your platform's trusted package manager. Rerun `doctor` to verify both executables. Do not treat a successful browser recording as proof that the final media was encoded or inspected.

## A selector or assertion fails

Stop rather than retrying a forced click. Check that the page is ready, the selector resolves to one visible target, the app produced the expected state, and the plan is bound to the current app version. Fix the earliest owning plan or app issue, then regenerate and audit the affected run.

## Narration does not fit

Shorten a nonessential thought or give the visible result more time. Keep the accepted meaning, captions, and natural speaking pace aligned. Never accelerate speech or remove a required action to hit an arbitrary duration.

## An audit is inconclusive or finds P0/P1

Do not publish. Inspect the cited timecode and evidence, repair the earliest responsible input, regenerate the affected media, and request a fresh independent audit. Missing or stale evidence is not a pass.
