# Runtime adapters

The package separates mission orchestration from target checks, browser capture, narration preparation, and rendering. Applications embedding the library can inject those integrations through the typed interfaces in `src/adapters.ts`.

## Boundaries

- `EnvironmentAdapter.checkTargetReady(plan)` returns a readiness flag and a bounded evidence hash. `closeOwnedSession(missionId)` is optional and may close only a session that adapter owns.
- `BrowserAdapter.capture(plan, missionDirectory, narration)` records the requested target and returns validated capture evidence.
- `NarrationAdapter.prepare(plan, missionDirectory)` prepares narration tracks and returns their relative paths, hashes, and durations.
- `RendererAdapter.render(plan, capture, narration, missionDirectory)` composes the final video and returns its hash and artifact locations.
- `PublisherAdapter` describes an application-owned publishing boundary. The current CLI and MCP do not call it or publish artifacts.

`adapterDependencies(actorId, adapters)` adapts the first four interfaces to the `prepare` and `generate` dependency objects. The built-in local runtime uses its Playwright, local speech, and Remotion implementations instead. Custom adapters do not bypass plan validation, mission receipts, artifact checks, or review requirements.

The built-in browser adapter is deliberately origin-isolated: HTTP(S) requests and WebSocket connections must stay on the exact origin in `targetUrl`, service workers are disabled, and popups are not part of the capture flow. It rejects every HTTP redirect, including a redirect to the same origin. Set `targetUrl` to the canonical URL that serves the page directly; a redirect, CDN asset, external login, or streaming endpoint is not an implicit exception. If an integration genuinely needs other origins or redirects, implement and separately review a custom `BrowserAdapter` rather than weakening the built-in boundary.

## Implement an adapter

The built-in target check hashes the successful document, title, status, and viewport. It cannot infer a live application's release, authentication, asynchronous report data, or fixture revision. For dynamic applications, your `EnvironmentAdapter` must verify those prerequisites and include their immutable fingerprints in `evidenceHash`; otherwise reuse can only attest the document, not changed backend data. Keep credentials and raw fixture content out of receipts.

Import adapter types from the package root, receipt/dependency contracts from `@jbjmllc/demo-studio/contracts`, and conventional runtime composition helpers from `@jbjmllc/demo-studio/runtime`. Implement only the boundary you own, and keep credentials in the host's secret manager or environment—not a plan or receipt. For example, a custom browser adapter should:

1. enforce a reviewed origin policy and the plan's requested viewport;
2. perform only the declared actions and verify visible postconditions;
3. return evidence and artifact paths contained in the mission directory;
4. report failures without serializing page content, credentials, or provider transcripts.

The explicit `./runtime` entry exports mission orchestration and built-in adapters from the same public source. `adapterDependencies()` is the composition helper. It is for conventional `node_modules` embedding, not in-process PnP. PnP hosts import the safe contracts/capsule API and use stdio MCP instead. Do not copy the engine or installer into an integration.

A typed `PublisherAdapter` alone is not publishing functionality. There is no CLI adapter-loading option; conventional embeddings explicitly instantiate their adapters. The capsule does not turn those host objects into remote plugins or provision application environments.

See [`src/adapters.ts`](../src/adapters.ts), [`src/contracts.ts`](../src/contracts.ts), and the [architecture guide](architecture.md) for exact TypeScript signatures and receipt boundaries.
