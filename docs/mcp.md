# Local MCP server

The marketplace plugin installs the six skills without starting an MCP process or requiring Node, Chromium, or media tools. Git checkouts do not contain compiled `dist/` files.

For the full runtime, first complete the [source build](quickstart.md) or install the compiled release archive. Verify `node /path/to/built/demo-studio/dist/cli.js doctor`, then configure `dist/mcp.js` as a local stdio process in your host. An npm archive installation places it at `node_modules/@jbjmllc/demo-studio/dist/mcp.js` instead.

The [Claude Code example](../examples/mcp/claude-code.json) must be copied into your host's project-local configuration with its path replaced. Other MCP hosts use their normal stdio settings:

```json
{
  "command": "node",
  "args": ["/path/to/built/demo-studio/dist/mcp.js"]
}
```

Replace the path with your actual built or installed runtime location. Restart the host and discover the tools; do not assume a prior connection is current. The server and CLI share validation rules. Keep their filesystem scope limited to the project or run workspace you requested. No hosted service or API key is required for the captioned workflow.

## Tools and sequencing

| Tool | Purpose |
| --- | --- |
| `demo_doctor` | Check only configured runtime and narration requirements. |
| `demo_prepare` | Validate the approved plan, target, and optional narration; return a durable mission ID. |
| `demo_generate` | Capture, render, and audit that prepared mission. Never publish automatically. |
| `demo_status` | Read durable stage and failure state without repeating work. |
| `demo_preview` | Return the plan and exact-hash review packet for visual inspection. |
| `demo_review` | Record a separately authored, exact-candidate semantic review. |
| `demo_reconcile` | Resolve an uncertain stage explicitly; no silent retry of paid speech or capture. |
| `demo_cleanup` | Release owned temporary resources while retaining every run artifact. |

`demo_generate` starts asynchronously by default. Poll `demo_status`, then inspect `demo_preview` when generation finishes. If your client uses `wait: true`, set a suitable request timeout: a client's default 60-second deadline can expire during rendering. Treat a disconnected running process as uncertain until status and reconciliation establish what completed. Do not start another mission merely because the client stopped waiting.

The runtime never authenticates a reviewer merely from its supplied ID, and deterministic audit success is not semantic approval. See the [CLI reference](cli.md) and [workflow guide](agent-workflow.md) for review, severity, and reconciliation contracts.
