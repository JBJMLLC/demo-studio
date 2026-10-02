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

Import the public types from the package entry point, implement only the boundary you own, and keep provider credentials in your host's secret manager or environment—not in a plan or receipt. For example, a custom browser adapter should:

1. enforce a reviewed origin policy and the plan's requested viewport;
2. perform only the declared actions and verify visible postconditions;
3. return evidence and artifact paths contained in the mission directory;
4. report failures without serializing page content, credentials, or provider transcripts.

The runtime currently exports mission orchestration and the built-in local adapters. `adapterDependencies()` is the supported composition helper. A typed `PublisherAdapter` declaration alone is not a publishing implementation. There is no CLI adapter-loading option; applications embedding the library must explicitly instantiate adapters in their own code.

See [`src/adapters.ts`](../src/adapters.ts), [`src/contracts.ts`](../src/contracts.ts), and the [architecture guide](architecture.md) for exact TypeScript signatures and receipt boundaries.
