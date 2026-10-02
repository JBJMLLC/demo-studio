# Contributing

Contributions should improve a reusable planning or recording workflow without making it depend on one product, private dataset, or paid agent service.

## Scope

- Keep each skill focused, composable, and usable on its own. Put conditional detail in a linked reference instead of expanding every entrypoint.
- Ground example claims in behavior the bundled fixture actually implements.
- Use synthetic, non-identifying data in plans, screenshots, logs, and tests.
- Keep user approval, actual browser evidence, and independent media review distinct.
- Document optional provider costs, credentials, and license terms; the default path should not require paid credentials.

## Checks

Before opening a pull request, run:

```sh
npm run typecheck
npm test
npm run build
npm run test:smoke
node scripts/check-skills.mjs
node scripts/check-public-boundary.mjs
```

The CI smoke test uses only the local synthetic fixture. Do not add organization secrets, private review bots, production browser targets, or customer data to a workflow.

## Reports

For a vulnerability report, follow [SECURITY.md](SECURITY.md). For a documentation or feature bug, open a public issue with a minimal reproduction and remove any private values first.
