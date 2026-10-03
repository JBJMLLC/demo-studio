# Pipeline contract

## Scout sheet

Before a writer drafts narration for a page, a zero-cost pass opens it with the recording session and writes a short sheet. The sheet holds the final URL, the page title, the main heading and breadcrumb, and every stable anchor (test ID or tour attribute) with its catalog name. It also lists visible buttons, links, tabs, inputs, and comboboxes by role and accessible name, plus the controls of any open dialog. Group repeated matches with a count and cap long lists, so the sheet fits in a prompt (about 40 lines). The writer chooses selectors and spoken anchors from the sheet, not from guesses.

Keep a target catalog for shared chrome: navigation, page header, list search, row links, create buttons. Prefer catalog anchors to text or CSS selectors. A selector that matches twice in strict mode often reveals a real app bug, such as a panel rendered once for desktop and once for mobile. Report it rather than adding `nth=0` by reflex.

## Rehearsal (pass 1)

- Lay out each scene's spoken text on a synthetic clock. Use an estimated words-per-second rate, the configured pause between sentences, and the same pronunciation map the voice will use. Then align actions exactly as a narrated run aligns them: on their spoken anchors, after the cursor runway and every wait.
- Run the real capture against the real app, with every assertion, target check, and error watcher.
- **Mirror the audit.** Every check the final audit fails must also fail the rehearsal. In particular, an active action that lands after the scene's narration has ended must fail, not warn: the real voice can be faster than the estimate. Use a safety margin (for example 500 ms inside the audit tolerance). Before this gate existed, renders failed only after minutes of voicing.
- Write a marker: `{ status, planHash, appUrl, at, failure?, warnings }`. Hash the plan's script content, excluding fields such as data-reset lists that do not change the video. Any script edit makes the marker stale.

## Voice and render queue (pass 2)

- Run one queue per machine. It selects plans whose latest rehearsal passed for their current hash and that have no render for the same plan hash and voice-configuration hash. Oldest pass goes first. Write `rendered` and `render-failed` markers, and skip a failed plan until it changes or an operator retries it.
- All voice calls go through one cross-process lock. A directory created with `mkdir` is enough; record its owner's process ID and reclaim the lock when that process is gone. Cache narration per sentence, keyed by spoken text, voice, and speed, so a re-run or a shared sentence costs nothing. Parallel recorders without a lock and cache cause rate-limit storms.
- Lock the voice configuration in one committed file: voice, speed, sentence gap, language, and pronunciation map. A slightly slow speed (around 0.9) and a sentence gap of about 500 ms suit step-by-step lessons. Changing the file re-renders every narration.
- Run the queue detached from any agent shell; agent shells and background tasks are often killed after a fixed time. Make it safe to stop at any moment: nothing is marked rendered until the video is in its final location.

## Data that stays put

- Each plan lists the resets it needs, applied in order before every rehearsal and render. A reset must be idempotent, restore every row the plan changes, and delete every row it creates, matched by the fictional names the plan types and scoped to the demo tenant.
- Anchor time-sensitive data to the recording day. Data seeded for "Monday" leaves a "today" screen empty on a weekend.
- Reset persisted user preferences too, such as the last chosen filter, pinned items, and column state.
- A plan that finishes leaves its own changes behind. The next plan's reset, not the previous plan, cleans up.

## Errors and privacy during capture

Fail the capture on an app error page, an error toast, or a server (5xx) response, even when the media audit passes. Report client errors (4xx) and console errors as warnings. Keep a short, tested noise allowlist for telemetry and third-party widgets. Refuse any network origin that is neither allowed nor known noise, and fail with the list. A new third-party origin is often a privacy finding, such as assets loaded from an unreviewed CDN.

## Environment before app

When a plan that passed before fails now with timeouts, 503s, unexpected 500s, or clock drift:

- Check machine load and container usage. Forgotten containers can starve the app and the recorder.
- Check for database drift. Tests that replay old migrations into the shared development database can silently break views.
- Record a production build on a fixed port, never a hot-reloading dev server, and never edit, merge, or reinstall in the served checkout during a run. To update the app, build into a new folder and swap it between renders.
- Check that the saved login is still valid.

## Producers and coordinator

The coordinator gives each producer a brief:

1. **Scope:** the lessons, the branch, and the files the producer owns.
2. **Setup:** read the audience guide and these skills; scout first.
3. **Commands:** the exact rehearsal command, with app URL and auth location. Producers never start or stop shared servers and never run narrated renders.
4. **Content rules:** start each lesson where the task starts (only a course's first lesson starts from home). Build from simple to complex, with an early "check your work" lesson and optional layers marked "skip if…". Script what the app actually does.
5. **Findings:** one section per producer in the findings file, with steps, expected and actual results, and the recorder evidence. Never change a plan to hide an app bug.
6. **Finish:** done means every lesson's rehearsal passes after its last edit. Report a short summary and open a pull request; do not merge.

The coordinator runs rehearsal batches in parallel (two to four at a time, depending on load), reads status from the markers rather than from agent reports, and runs the single queue. It then hands all findings to one filing agent, which dedupes them and files them where the team tracks issues. Configure the findings file to union-merge, or give each producer its own file, so parallel appends do not conflict.
