# Plan format

The plan is the durable source for one walkthrough. The runtime validates its shape before opening a browser. Keep story intent readable and product claims supported by current evidence.

## Top-level fields

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Plan schema version; currently `1`. |
| `id`, `title` | Stable run identifier and human-readable outcome. |
| `product`, `audience`, `outcome` | Product surface, intended viewer, and one primary result. |
| `mode` | Required output mode: `captioned` for the no-provider path or `narrated` with a configured narrator. |
| `presentation` | Cursor, caption and zoom settings, for example `{"cursor":"pointer","captions":true,"zoom":1.6}`. `zoom` (1–3, default 1 = off) eases the camera toward each click, typing and drag, and pans between actions that are close together. |
| `duration` | An editorial target and whether it is a hard limit, for example `{"targetSeconds":35,"hardLimit":false}`. |
| `targetUrl` | Exact app URL. Use the included loopback fixture for the quickstart. |
| `viewport` | Capture width and height in CSS pixels. |
| `fps` | Capture and composition frame rate; currently fixed at `30`. |
| `scenes` | Ordered story beats, actions, and visible assertions. |

## Scene fields

Each scene has an `id`, `before`, `during`, `after`, `say`, `learn`, `next`, and `holdMs`, plus `actions` and `assertions` arrays. Describe each scene in viewer terms: the starting evidence, the meaningful change, the readable result, the spoken explanation, what the viewer learns, and how the next scene follows.

Selectors and timings belong in the scene's actions, not in the story prose. Every state-changing behavior required by the brief should have at least one action and an assertion for its visible result.

## Action fields

Supported action types are `navigate`, `click`, `type`, `drag`, `wait`, and `press`. Actions can include `id`, `selector`, `value`, `url`, `toSelector`, and `atMs`, depending on type. `drag` starts at `selector` and ends at `toSelector`. Active `click`, `type`, and `drag` actions require a `spokenAnchor` copied verbatim from the scene's `say` text. `atMs` is relative to the start of its scene; keep actions in story order and leave enough room for natural speech and readable results.

Use stable accessible locators or explicit test IDs. Do not target a decorative icon when a named button or control exists.

## Assertions

Assertions use a selector, a `kind`, and, for text checks, a `value`:

- `visible` — the expected product element is visible.
- `text` — the expected visible text is present.

Assert the product result, not the fact that an input event fired. For state changes, assert the new state and retain any neighboring evidence the story promises.

## Example

See [`examples/quickstart/plan.json`](../examples/quickstart/plan.json) for a complete plan. It creates a populated chart, widens it, and opens a read-only view of the same synthetic data.

## Invalidation

`wordingApproval.sha256` binds the exact approved scene wording fields to the plan. Compute it with the provided helper; do not hand-author a digest or claim that a hash is a human decision. A packaged example may ship with maintainer-authored wording and its matching integrity hash. A user's new wording still needs the requested interactive approval.

Review decisions and generated artifacts depend on their input hashes. If story, exact narration, target state, actions, or scene order changes, regenerate affected descendants and repeat the relevant review. Never describe a stale approval as current.
