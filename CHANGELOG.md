# Changelog

## Unreleased

- Scope lesson-length guidance to course and tutorial lessons, keep product walkthroughs on their approved brief/channel duration, use a conservative sufficient WCAG flash rule, and distinguish the project's loudness target from conditional EBU guidance.
- Fold course-platform, accessibility, and video-learning guidance into the skills: teaching outcomes, terms, and channel requirements in the brief; one task per lesson and capability endings in the storyboard; named references and caption-friendly lines in narration; viewport legibility and pointing style in recording; and new audit [delivery checks](skills/demo-audit/references/delivery-checks.md) for phone-size legibility, a muted watch, loudness, caption reading limits, flashes, length, and sidecar deliverables. Sources are listed in [instructor guidelines](docs/instructor-guidelines.md).

## 0.1.3

- Add explicit legacy `mediaClock` limits (`maxOffsetDriftMs`, `maxUncertaintyMs`) to `BrowserCaptureOptions`, reject invalid limits before capture, and report measured frame spacing in drift failures. Keep default limits unchanged; a wider exploratory policy is not a synchronization fix.
- Add an explicit browser-domain to video-PTS contract with recording/context/document/origin/reset identities, exact evidence references, both measured transition brackets, fixed-offset mapping, and conservative uncertainty. Reject drift or uncertainty beyond `ceil(1000 / fps)`; never infer a clock basis or adjust playback speed.
- Decode configurable uniform-RGB or explicit RGB-range markers without changing their geometry. Retain raw preceding/first-changed presentation timestamps even when evidence is rejected.
- Keep Remotion's routine browser-download and rendering logs out of the MCP JSON-RPC stdout stream.

- Add the `demo-production-pipeline` skill: scout before scripting, silent rehearsal gated like the audit, one serialized voice and render queue, per-plan data resets, environment checks, and a producer/coordinator split. Fold the matching lessons into the recording, narration, and audit skills.

- Render with Remotion's pinned Chrome Headless Shell instead of Playwright's Chromium. Current full Chromium builds return tiled, mis-scaled frames, which failed the first-frame integrity check.
- Add `presentation.zoom` (1–3, default off): the camera eases toward each click, typing and drag, and pans between nearby actions. The zoom windows are recorded in `render/timeline.json`.
- Letterbox the recording and caption band in black instead of light gray.

## 0.1.2

- Add an integrity-pinned conventional runtime capsule and PnP-safe host exports/stdio launcher, with explicit install and retry reconciliation.
- Preserve conventional runtime adapter APIs behind `@jbjmllc/demo-studio/runtime`; do not load them in-process under PnP.
- Require a toolkit-only PnP consumer for installed-archive capture/render/review/restart qualification. Ancestor test dependencies must not mask peer failures.

## 0.1.1

- Keep Zod 3 within the MCP SDK's supported peer range. The initial PnP startup harness supplied ancestor dependencies and did not qualify toolkit-only Remotion consumers; that limitation is disclosed in the release notes.
- Add a production-archive Yarn Plug'n'Play regression that checks the resolved SDK/Zod peer and discovers the installed MCP tools.
- Reuse the approved v0.1.0 synthetic media unchanged; this patch only updates package compatibility and metadata.

## 0.1.0

- Accept an optional `{ createSession, ready }` argument in the built-in `capture()` and `checkTargetReady()`, so an embedding application can supply its own reviewed browser session and readiness wait without copying the capture implementation. The default remains the strict single-origin session; the CLI and MCP are unchanged.
- Keep the original capture or render error as the in-memory `cause` of a failed `generate()`; mission receipts still never serialize it.
- Add six composable story-first demo skills, a synthetic browser fixture, local CLI/MCP documentation, and public-boundary checks.
