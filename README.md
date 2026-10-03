# Demo Studio

Story-first, local-first skills and tools for planning, recording, and auditing product walkthroughs. Start with the viewer's goal and product proof; capture the approved story in a real browser, then audit the actual screen and speech.

The seven skills are composable and work one at a time. The local toolchain supplies a captioned default, a synthetic browser fixture, and auditable run artifacts. Optional voice providers may require separate credentials and terms; the default does not.

## Example output

The [captioned Fieldnote walkthrough](https://github.com/JBJMLLC/demo-studio/releases/download/v0.1.2/fieldnote-demo.mp4) records adding a populated chart, widening it, and opening a read-only share view. It uses an original fictional app and synthetic records, with no credentials or voice recording. [Release assets](https://github.com/JBJMLLC/demo-studio/releases) include compiled archives, the video, poster, checksums, and an independent review summary. The example is captioned, not narrated; optional speech uses your own authorized recordings or provider configuration.

## Install a skill

Use the skills CLI to browse or install the public pack:

```sh
npx skills add JBJMLLC/demo-studio
```

For a local project copy into Codex, choose a skill and omit `--global`:

```sh
npx skills add JBJMLLC/demo-studio --skill demo-brief --agent codex --copy
```

Replace `demo-brief` with `demo-storyboard`, `demo-narration`, `demo-story-review`, `browser-demo-recording`, `demo-audit`, or `demo-production-pipeline`. Project-local copies avoid overwriting user-global skills. Claude Code users can add this repository as a marketplace:

```text
/plugin marketplace add JBJMLLC/demo-studio
/plugin install demo-studio@demo-studio
```

The marketplace plugin installs skills only: it never starts an unbuilt server. For recording and rendering, build the runtime or install the compiled release archive, then explicitly configure the [local MCP server](docs/mcp.md).

## Run the synthetic quickstart

Requirements: Node.js 22 or newer, npm, Playwright Chromium, FFmpeg, and `ffprobe`. Remotion is included for composition; its terms remain separate from this repository's MIT license. No paid account or API key is needed for the captioned path. This repository is source-first; no npm package is published.

Clone the public source repository:

```sh
git clone https://github.com/JBJMLLC/demo-studio.git
cd demo-studio
```

```sh
npm ci
npx playwright install chromium
npm run build
```

For a single-command end-to-end check, run:

```sh
npm run test:smoke
```

The smoke task manages its own fictional app and local work directory. To inspect the CLI stages manually, start the app in one terminal:

```sh
npm run example
```

It listens on `http://127.0.0.1:4399`. In a second terminal, prepare and run the plan. The shell captures the mission ID from the command's JSON output:

```sh
set -o pipefail
node dist/cli.js doctor
node dist/cli.js validate --plan examples/quickstart/plan.json
DEMO_MISSION_ID="$(node dist/cli.js prepare --plan examples/quickstart/plan.json --work-dir .demo-studio/quickstart | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).missionId));')"
node dist/cli.js generate --mission "$DEMO_MISSION_ID" --work-dir .demo-studio/quickstart
node dist/cli.js status --mission "$DEMO_MISSION_ID" --work-dir .demo-studio/quickstart
node dist/cli.js preview --mission "$DEMO_MISSION_ID" --work-dir .demo-studio/quickstart
```

`generate` records the real browser interactions and includes media checks. The generated `review-packet.json` is evidence, not approval. An independent semantic reviewer must author a separate exact-hash `review.json`; no ready-to-submit review is generated. Submit that review before running `cleanup`, which closes the mission while preserving every run artifact. See the [review commands](docs/quickstart.md). The example adds a populated chart, widens it, then opens a read-only share view.

For the project layout, exact commands, plan fields, privacy defaults, and repair steps, see the [documentation index](docs/index.md). The seven skills and their boundaries are listed in [the skills guide](docs/skills.md).

## Development checks

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
node scripts/check-skills.mjs
node scripts/check-public-boundary.mjs
```

Before packaging, scan the produced release archive too: `node scripts/check-public-boundary.mjs --archive path/to/package.tgz`.

The source-boundary command runs its own synthetic positive/negative fixtures before scanning repository files. It checks generic private-network, credential, path, and archive hazards; it does not contain a private-term dictionary. An optional `--private-terms-file` can supply a local denylist from outside the checkout, and reports only file names and rule IDs.

Source archives are not installed as an npm package. For a built tarball, install the archive locally with `npm install /path/to/package.tgz`, then run the packaged CLI with `node node_modules/@jbjmllc/demo-studio/dist/cli.js`; `npm run` source scripts are not part of that consumer workflow. This repository has not published an npm package.

## Yarn Plug'n'Play and integrations

The package root, schemas, contracts, media-clock helpers, and capsule API are safe host imports. Under Yarn Plug'n'Play, capture, rendering and MCP run in an integrity-pinned standalone runtime, not the host's in-process Remotion dependency graph.

Add a downloaded, checksum-verified toolkit archive to your Yarn project, then run:

```sh
yarn exec demo-studio capsule status
yarn exec demo-studio capsule install
yarn exec demo-studio doctor
yarn exec demo-studio mcp
```

Installation is explicit. Doctor never downloads or repairs a runtime. Cache reuse requires matching artifact identity, owned installed bytes, Node ABI, OS, architecture, and Linux libc where applicable. Failed or uncertain installs require inspection and explicit reconciliation.

Source clones and conventional npm installations can use the bundled runtime directly. Advanced adapter embedding uses `@jbjmllc/demo-studio/runtime` in a conventional `node_modules` installation; PnP applications use [stdio MCP](docs/mcp.md). See [configuration](docs/configuration.md), [adapters](docs/adapters.md), and [troubleshooting](docs/troubleshooting.md).

## License

This repository is licensed under the MIT License. Dependencies, optional rendering tools, and voice providers retain their own license and service terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
