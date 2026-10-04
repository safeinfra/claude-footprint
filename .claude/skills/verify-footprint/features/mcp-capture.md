# MCP capture

When Claude calls an MCP tool that its server does not mark read-only, footprint adds a row under `MAY HAVE CHANGED`, scoped to the MCP server. Tools marked read-only are not drawn.

## Sub-features

- `mcp-maybe` a worked call to a non-read-only MCP tool appears under `MAY HAVE CHANGED (n)` with the server as the scope line.
- `mcp-readonly-hidden` a call to a read-only MCP tool adds no row.
- `mcp-export` MCP calls appear in the export with `"tool":"mcp"`.

## How to get to it (user POV)

- Ask Claude to do something that uses an MCP tool, then open `/map`.

## Driving it with drive.sh

Preconditions:

- Baseline from the [index](./README.md).
- An MCP server in the nested session with a tool that changes nothing real but is not marked read-only. None has been picked yet.

- **Not driven yet.** Pick a harmless tool first, ask the user before calling anything that could act on a real system, then ask the nested Claude to call it and `wait`. Expect a `MAY HAVE CHANGED` section with the server name. Record the real pane text here once proven.
- **Proof.** `drive.sh capture <name> mcp-after` and `drive.sh export <name>`; the trace line has `"tool":"mcp"`.

## Gotchas

- The nested session loads the user's MCP servers, which reach real systems (Slack, Jenkins, Kafka...). Most of their tools act on the world. Do not call them for a verification run.
- Read-only tools never show, so an empty pane after an MCP call can be correct.
