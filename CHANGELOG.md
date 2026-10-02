# Changelog

## 0.1.2

- Add an integrity-pinned conventional runtime capsule and PnP-safe host exports/stdio launcher, with explicit install and retry reconciliation.
- Preserve conventional runtime adapter APIs behind `@jbjmllc/demo-studio/runtime`; do not load them in-process under PnP.
- Require a toolkit-only PnP consumer for installed-archive capture/render/review/restart qualification. Ancestor test dependencies must not mask peer failures.

## 0.1.1

- Keep Zod 3 within the MCP SDK's supported peer range. The initial PnP startup harness supplied ancestor dependencies and did not qualify toolkit-only Remotion consumers; that limitation is disclosed in the release notes.
- Add a production-archive Yarn Plug'n'Play regression that checks the resolved SDK/Zod peer and discovers the installed MCP tools.
- Reuse the approved v0.1.0 synthetic media unchanged; this patch only updates package compatibility and metadata.

## 0.1.0

- Add six composable story-first demo skills, a synthetic browser fixture, local CLI/MCP documentation, and public-boundary checks.
