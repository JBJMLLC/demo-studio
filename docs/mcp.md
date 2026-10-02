# Local MCP server

The Claude Code plugin manifest configures Demo Studio as a local stdio MCP server. It runs the packaged `dist/mcp.js` from the plugin checkout and passes `CLAUDE_PLUGIN_ROOT` as the local plugin root. It does not point to a hosted service.

Install the plugin from this repository's Claude marketplace manifest, then enable the `demo-studio` server in the host. The server and CLI use the same local workspace and validation rules. Keep its filesystem scope limited to the project or run workspace the user requested.

For another MCP-capable host, configure the local process using the host's normal stdio settings:

```json
{
  "command": "node",
  "args": ["/path/to/installed/demo-studio/dist/mcp.js"],
  "env": {
    "DEMO_STUDIO_PLUGIN_ROOT": "/path/to/installed/demo-studio"
  }
}
```

Replace both local paths with the installed plugin's actual location. Do not copy this example as a global service configuration if a project-local plugin is sufficient. The server does not accept a remote URL or require an API key for the default local workflow.
