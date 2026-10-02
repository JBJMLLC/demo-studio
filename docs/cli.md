# CLI reference

Build once from the repository with `npm run build`, then run commands as `node dist/cli.js <command>`. The CLI uses the local work directory you specify. The default captioned path does not need a hosted service.

## Commands

| Command | Purpose |
| --- | --- |
| `doctor [--narration supplied|voicebox|elevenlabs] [--skills-only]` | Check local tools and, if requested, one optional narrator configuration. |
| `validate --plan <path>` | Validate plan fields and exact wording hash before preparing a mission. |
| `prepare --plan <path> [--work-dir <path>] [--actor <name>]` | Prepare a mission workspace and return its mission ID. |
| `generate --mission <id> [--work-dir <path>] [--actor <name>]` | Record the approved browser flow, render a candidate, and run built-in media checks. |
| `status --mission <id> [--work-dir <path>]` | Read the current mission state and artifact summary. |
| `preview --mission <id> [--work-dir <path>]` | Print the current plan and review packet. It does not open a video preview. |
| `review --file <review.json> [--work-dir <path>]` | Validate and record a separate exact-hash semantic review submission. |
| `cleanup --mission <id> [--work-dir <path>] [--actor <name>]` | Release mission-scoped resources while preserving every run artifact. |
| `reconcile --mission <id> --action retry-uncertain-stage\|accept-captured-artifacts [--work-dir <path>]` | Explicitly resolve an uncertain stage after inspecting its durable status. |
| `mcp` | Start the local stdio MCP server. |
| `capsule status` | Read the pinned runtime cache state without installing it. |
| `capsule install` | Explicitly acquire and install the integrity-pinned standalone runtime. |
| `capsule reconcile --action retry-failed-stage\|retry-uncertain-stage` | Explicitly recover the matching failed or uncertain install after inspecting its receipt. |

The default work directory is `.demo-studio`. `prepare` prints the mission JSON, including the ID to reuse for later commands. For a complete example that safely captures that value into a shell variable, see the [quickstart](quickstart.md).

Use `yarn exec demo-studio <command>` in a PnP consumer. Install its capsule explicitly before runtime commands. Once ready, doctor checks the configured software and optional narration requirements in that runtime; it never installs them. Conventional npm/source use can run the bundled runtime directly. Capsule recovery is separate from mission recovery and cannot approve or silently restart a video.

Source checkouts that need capsule commands must also run `npm run pack:runtime` to generate the descriptor and runtime artifact. This is not required for ordinary source capture using the bundled runtime.

`generate` includes media checks; there is no separate `audit` CLI command. The generated `review-packet.json` is evidence for a reviewer. It is distinct from the reviewer-authored `review.json` submitted after independent semantic review. `cleanup` does not delete captured video, screenshots, review records, or other artifacts.

## Optional semantic review file

Create this file only after an independent semantic review of the actual screen and speech. Replace each example value with exact current data from the generated mission, packet, plan, and render evidence. The following is explicitly a non-approval example:

```json
{
  "missionId": "demo-0123456789abcdef01234567",
  "packetHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "planHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "videoHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "reviewerId": "independent-reviewer",
  "reviewerType": "independent",
  "verdict": "revise",
  "checks": {
    "contentTruth": "inconclusive",
    "uxQuality": "inconclusive"
  },
  "findings": []
}
```

`reviewerType` is `independent` or `operator`; `verdict` is `approved` or `revise`; each check is `pass`, `fail`, or `inconclusive`. Findings use `id`, severity `P0`–`P3`, optional `sceneId`, `summary`, and optional disposition `fixed`, `accepted`, or `rejected`. Use `approved` only when both checks support it and no unresolved stop finding remains. The resulting receipt sets `identityAssurance` to `caller-attested`. The runtime hashes the caller-supplied `reviewerId` and rejects it if it matches the stored producer fingerprint. This is a local comparison—not authentication or cryptographic proof of who reviewed the video. The caller is responsible for ensuring an actually independent reviewer; the narration author must not be the sole reviewer.

`wordingApproval.sha256` binds the exact scene wording for integrity. It is not human approval. A review submission binds a verdict to `missionId`, `packetHash`, `planHash`, and `videoHash`; the reviewer ID and type are caller-provided declarations, not authenticated credentials.

## Reconcile an uncertain run

First inspect `status` and durable receipts. If an external outcome is uncertain, choose exactly one action and use the ID printed by `prepare`:

```sh
node dist/cli.js reconcile --mission "$DEMO_MISSION_ID" --action retry-uncertain-stage --work-dir .demo-studio/quickstart
```

Do not retry paid narration automatically. Choose `accept-captured-artifacts` only when the existing artifacts are verified and should be retained. Reconciliation is an explicit recovery decision, not a substitute for review.
