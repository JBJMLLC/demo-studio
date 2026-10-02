# Quickstart

This quickstart uses only the bundled fictional app and synthetic records. The CLI captures the real browser flow, renders a captioned candidate, and writes review evidence. It does not create an approval or publish anything.

## Prerequisites

- Node.js 22 or newer and npm.
- Playwright Chromium.
- FFmpeg and `ffprobe` for media generation and inspection.

Remotion is included for composition; its terms are separate from this project's MIT license. The captioned default does not need external accounts or API keys.

## Install and build

From a clone of this repository:

```sh
git clone https://github.com/JBJMLLC/demo-studio.git
cd demo-studio
npm ci
npx playwright install chromium
npm run build
node dist/cli.js doctor
```

If you already have a checkout, skip the first two commands. The same build steps work after extracting a source archive. No registry package is published; use the source build or a compiled release archive below.

## Install a compiled release instead

Download a toolkit `.tgz` and `SHA256SUMS` from the same [release](https://github.com/JBJMLLC/demo-studio/releases). Verify the archive before installation. A GitHub source archive is not a compiled npm archive.

For a conventional npm project:

```sh
npm install /absolute/path/to/jbjmllc-demo-studio-VERSION.tgz
npx playwright install chromium
node node_modules/@jbjmllc/demo-studio/dist/cli.js doctor
```

Replace `VERSION` and the path with your downloaded artifact. Run the bundled fictional server at `node_modules/@jbjmllc/demo-studio/examples/quickstart/server.mjs` and use its adjacent `plan.json`, or keep a source checkout for the manual example below. Repository development scripts are not consumer commands.

For a Yarn Plug'n'Play project, add the same toolkit archive with your project's Yarn package manager. From that project directory:

```sh
yarn exec demo-studio capsule status
yarn exec demo-studio capsule install
yarn exec demo-studio doctor
```

The install command explicitly acquires the separate runtime selected by the toolkit's exact version, archive digest, immutable URL, and file inventory. It uses an isolated conventional dependency tree without modifying the workspace graph or global configuration. Chromium, FFmpeg and `ffprobe` are still required; doctor checks readiness without installing them. Run the normal commands through `yarn exec demo-studio`, not direct JavaScript paths inside a PnP archive.

Do not import `@jbjmllc/demo-studio/runtime` in-process under PnP. Use safe host exports and the [stdio MCP boundary](mcp.md). Inspect failed or uncertain installs before [explicit capsule recovery](troubleshooting.md).

## One-command smoke

Run the complete local fixture workflow without starting the example server separately:

```sh
npm run test:smoke
```

The smoke task starts and stops the synthetic fixture, prepares a mission, captures the browser flow, renders the video, checks sampled frames and restart reuse, verifies stale review rejection, and confirms cleanup retains its artifacts. It does not claim semantic approval. Use this path for a quick end-to-end check; the manual path below is for inspecting each command.

## Manual browser walkthrough

Start the fixture in one terminal and leave it running:

```sh
npm run example
```

It binds to `http://127.0.0.1:4399` by default. In another terminal, validate the plan and prepare a mission. This shell snippet reads the mission ID from the JSON result rather than asking you to type a placeholder:

```sh
set -o pipefail
node dist/cli.js validate --plan examples/quickstart/plan.json
DEMO_MISSION_ID="$(node dist/cli.js prepare --plan examples/quickstart/plan.json --work-dir .demo-studio/quickstart | node -e 'let input=""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).missionId));')"
node dist/cli.js generate --mission "$DEMO_MISSION_ID" --work-dir .demo-studio/quickstart
node dist/cli.js status --mission "$DEMO_MISSION_ID" --work-dir .demo-studio/quickstart
node dist/cli.js preview --mission "$DEMO_MISSION_ID" --work-dir .demo-studio/quickstart
```

`preview` prints the current plan and review packet; it does not open the video. Inspect the output under `.demo-studio/quickstart/missions/$DEMO_MISSION_ID/`, including `render/demo.mp4`, `render/poster.png`, sampled frames, and `review-packet.json`.

## Optional review submission

The generated `review-packet.json` is evidence, not approval. An independent semantic reviewer must compare the actual screen and speech against the approved story. Only after that review should the reviewer author a separate `review.json` that binds verdicts and findings to the exact current mission, packet, plan, and video hashes. No ready-to-submit review file is generated for you.

After that file exists, validate and record it:

```sh
node dist/cli.js review --file .demo-studio/quickstart/review.json --work-dir .demo-studio/quickstart
```

Do not submit a guessed, stale, self-approved, or inconclusive review as approval. The [CLI reference](cli.md) contains the exact schema and optional reconciliation command.

## Cleanup

When finished reviewing, release mission-scoped temporary resources:

```sh
node dist/cli.js cleanup --mission "$DEMO_MISSION_ID" --work-dir .demo-studio/quickstart
```

Cleanup preserves every run artifact. Inspect the exact work directory before the command; it must not point at source files or other user data. See [Troubleshooting](troubleshooting.md) if the fixture, browser, or media tools do not start.

## Optional voice

The default path uses captions without paid credentials. Optional providers and variables are described in [configuration and narration](configuration.md). The [supplied-audio plan example](../examples/quickstart/narrated-plan.example.json) contains no audio; add authorized audio files and align its action timings before use. Keep accepted words and captions aligned, review current provider terms, and preserve a natural pace. Do not put provider credentials in the plan or command line.
