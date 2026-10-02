# Plan and narration configuration

Plans are JSON files. Validate a plan before preparing a mission:

```sh
node dist/cli.js validate --plan examples/quickstart/plan.json
```

The required fields and action formats are in the [plan reference](plan-format.md). The plan declares the target URL, viewport, scenes, and exact story wording. Keep provider credentials and service routing out of the plan unless a local-only provider explicitly requires a non-secret value there.

Use a canonical `targetUrl` that serves the page directly. The built-in browser adapter blocks all HTTP redirects (even same-origin redirects), restricts HTTP(S) and WebSocket traffic to that exact origin, disables service workers, and does not permit popups. Keep required browser assets on the same origin; a CDN, external login, or streaming service needs a separately reviewed custom `BrowserAdapter`, not an allowlist override in the built-in adapter. See [adapter boundaries](adapters.md).

## Captioned output

Use `"mode": "captioned"` for the no-provider default. Captions are generated from each scene's `say` field. Set `presentation.captions` to `false` only when the requested presentation needs no captions. The captioned workflow does not require a voice profile, key, or hosted speech service.

## Optional narrated output

Use `"mode": "narrated"` and a `narrator` configuration. Keep scene text, active-action anchors, and supplied or generated speech aligned. The runtime leaves generated speech at normal playback speed; revise the script or allow more time rather than speeding up speech.

### Supplied recording

Audio files are paths relative to the directory containing the plan and must stay inside that directory. Provide a file for every non-empty narrated scene:

```json
{
  "mode": "narrated",
  "narrator": {
    "provider": "supplied",
    "audioFiles": {
      "opening": "audio/opening.wav",
      "result": "audio/result.wav"
    }
  }
}
```

The audio file keys must match the plan's scene IDs. The runtime copies each selected track into the mission workspace and records its hash. Treat personal voice recordings as private source material; include or distribute them only with the speaker's authorization.

[`examples/quickstart/narrated-plan.example.json`](../examples/quickstart/narrated-plan.example.json) shows the complete browser flow configured for supplied audio. It is a template: the referenced WAV files are not included. Add your own authorized recordings under the plan directory or edit the relative paths, then align `atMs` values with the action phrases before preparing a mission. The sample contains no voice recording, voice profile, or provider credential.

### Voicebox

Voicebox is optional and must be a locally configured loopback service. Set `DEMO_STUDIO_VOICEBOX_URL` and `DEMO_STUDIO_VOICEBOX_PROFILE_ID` in the local environment, then select `"provider": "voicebox"`. A plan may carry a non-secret profile ID or local base URL, but environment values take precedence. The URL must use HTTP on `localhost`, `127.0.0.1`, or `[::1]`; remote Voicebox URLs are refused.

### ElevenLabs

Select `"provider": "elevenlabs"`, then configure `ELEVENLABS_API_KEY` and `DEMO_STUDIO_ELEVENLABS_VOICE_ID` outside the plan. `DEMO_STUDIO_ELEVENLABS_BASE_URL` can override the service origin in the local environment. Review current provider price, privacy, retention, and voice-use terms before sending text. The key is never stored in the plan or mission receipt.

Run `node dist/cli.js doctor` before preparation. The CLI explicitly checks the optional `voicebox` and `elevenlabs` settings with `doctor --narration voicebox|elevenlabs`; supplied files are validated against the plan during preparation. Never put keys in shell arguments, source control, screenshots, or review files.

## Integrity versus approval

`wordingApproval.sha256` is computed over each scene's `id`, `before`, `during`, `after`, `say`, `learn`, and `next` fields. It detects changes; it does not establish that a person approved those words. The separate semantic `review.json` submitted after generation binds the reviewer verdict to the current mission, packet, plan, and video hashes. Its resulting receipt marks `identityAssurance` as `caller-attested`; the tool checks the declared reviewer ID locally but does not authenticate a person or verify the declared role. Actual independence must be established by the surrounding review process. See [the review workflow](skills.md) and [CLI reference](cli.md).
