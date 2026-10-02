# Privacy and optional providers

The bundled quickstart uses synthetic data and serves the fixture on loopback (`127.0.0.1`). Generated run files stay under the workspace you pass to the CLI. The default captioned workflow does not need a paid voice service or API key.

## Before capturing a real app

- Confirm the exact target URL and account are in scope for the user's request.
- Use a disposable or synthetic dataset when possible. Keep customer names, identifiers, access links, secrets, and browser credentials out of plans, narration, screenshots, logs, and release archives.
- Use only the app state needed to demonstrate the approved story. Check the full frame, browser chrome, notifications, and captions for incidental private data.
- Keep output inside the declared run workspace and review it before sharing.

## Optional narration or rendering services

Voice generation, if selected, can send approved script text to the chosen provider. Optional environment settings are `ELEVENLABS_API_KEY`, `DEMO_STUDIO_ELEVENLABS_VOICE_ID`, `DEMO_STUDIO_ELEVENLABS_BASE_URL`, `DEMO_STUDIO_VOICEBOX_PROFILE_ID`, and `DEMO_STUDIO_VOICEBOX_URL`. Review that provider's current privacy, retention, and licensing terms before use. You may instead use a locally supplied recording. Keep voice files private unless the speaker has authorized their inclusion and distribution.

Optional video-composition dependencies may carry terms separate from this project's MIT license. Verify the exact installed version and intended use before commercial distribution; see [third-party notices](../THIRD_PARTY_NOTICES.md).

Do not place secrets in JSON plans, `.mcp.json`, shell arguments, source files, or audit output. Keep provider keys in the approved local secret mechanism and never print them in diagnostics.

Before a release, run `node scripts/check-public-boundary.mjs` and scan the exact archive with `node scripts/check-public-boundary.mjs --archive path/to/package.tgz`. The check includes synthetic positive and negative fixtures, scans filenames as well as text, rejects unexpected binary source files, and requires an audited manifest for included PNG/MP4 media. An optional external `--private-terms-file` can add a local denylist; its terms are not printed in findings.
