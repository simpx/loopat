# scripts/

Misc dev scripts. Not loaded by the loopat server at runtime.

## mock-mcp-server.ts

A self-contained OAuth-protected MCP server for **local testing** of
loopat's `Settings → MCP Auth` flow without depending on a real MCP server.

Implements RFC 9728 (protected-resource metadata), RFC 8414
(authorization-server metadata), RFC 7591 (dynamic client registration),
Authorization Code Flow + PKCE, and a minimal MCP HTTP endpoint with one
fake tool `mock_echo`. Auto-approves the consent page (no human click).

### Usage

```sh
bun run scripts/mock-mcp-server.ts
# listens on http://127.0.0.1:7799
```

Add to your workspace `knowledge/.loopat/claude/claude.json`:

```json
{
  "mcpServers": {
    "mock": {
      "type": "http",
      "url": "http://127.0.0.1:7799/mcp"
    }
  }
}
```

Then in loopat UI: **Settings → MCP Auth → Connect mock**. Your browser
will round-trip through the mock's OAuth endpoint and land back with a
token written to `personal/<user>/.loopat/vaults/<vault>/mcp-tokens.json`.

The next loop you spawn will see the `mock` MCP server with the
`Authorization: Bearer <token>` header pre-injected — sandboxed CC will
**not** trigger its own OAuth flow.

### Configuration

| env | default | meaning |
|---|---|---|
| `PORT` | `7799` | port to listen on |
| `HOST` | `127.0.0.1` | bind address |
| `PUBLIC_BASE` | derived | URL announced in OAuth metadata. Override if proxying. |

### Resetting

Mock state is in-memory. Restart the script to drop all clients +
tokens. Existing loopat tokens for `mock` will then 401 against `/mcp`
until you re-`Connect` via the UI.
