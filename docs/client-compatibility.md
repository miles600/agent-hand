# Client compatibility

Check these separately: **MCP connects**, **browser tools work**, and **the model receives images**. Tool discovery or a screenshot file path proves only part of the chain. Repeat the visual test when changing the client version or model.

## 1. Configure MCP and load the Skill

Build Agent Hand with `npm run build`. Configure a stdio server whose command is your absolute Node executable and whose arguments are `/absolute/path/to/agent-hand/dist/bridge/index.js`, `mcp`. The Chrome extension and MCP share `~/.agent-hand/config.json`. An existing bridge is reused.

For clients with `mcpServers` JSON configuration:

```json
{
  "mcpServers": {
    "agent-hand": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/agent-hand/dist/bridge/index.js", "mcp"]
    }
  }
}
```

Use the client's MCP settings/import UI; JSON keys and config locations differ. Prefer absolute paths because desktop apps may not inherit your terminal PATH. Codex's TOML configuration is in the main README.

Load [the small Agent Hand Skill](../skills/agent-hand/SKILL.md). For Codex, copy its `agent-hand` folder into `~/.codex/skills/`. For other clients, install it using their Skill mechanism or include its body in project instructions if Skills are unavailable. The MCP initialize response also contains the essential observe/act/verify instructions, but clients may ignore those instructions.

## 2. Probe the server

```sh
npm run check:mcp
node dist/bridge/index.js list-tabs
npm run check:mcp -- --tab <test-tab-id>
```

The first command checks newline stdio, initialization, and tool discovery. With `--tab`, the probe selects that existing tab and checks observation plus PNG image content. It prints dimensions, byte count, and the local file path, without the auth token or base64. It does not test how Cursor, Codex, or another client passes images to its model; `modelVision` remains `not-tested`.

If the bridge is already running an older build, restart that bridge after building; a new MCP process reuses the existing one. Reload the Chrome extension after extension updates.

## 3. Prove the model sees images

Use `node dist/bridge/index.js new-tab http://127.0.0.1:17321/demo/vision.html` to create a separate Chrome test tab (replace the port if configured differently), or choose an existing disposable tab. Note its returned `tabId`. This command navigates it to a local test page and leaves it there:

```sh
npm run check:mcp -- --tab <test-tab-id> --vision
```

Then give the following task to **the client and model being tested**, replacing the tab ID:

> Use only Agent Hand MCP. Observe test tab `<test-tab-id>` with `includeScreenshot:true`. Read the six-character canvas code directly from the returned MCP image. Do not open a PNG file, inspect page source, or use another browser tool. Fill “Code from screenshot”, click “Verify code”, and verify “PASS: visual code matched.” If the image did not reach you, say so instead of guessing. Report the client version, model, delivery mode, and observed result.

The random code is drawn on canvas; it is absent from the URL, snapshot labels, and page text. A correct answer plus page confirmation is evidence of the visual/action/verification loop when the agent follows the test constraints. It is a diagnostic, not a security boundary. Record whether a local image-viewer fallback was used separately; that does not pass the native MCP image test.

## 4. Record per-client evidence

No product is marked compatible solely because it advertises MCP support.

| Client | MCP connects | Observation/action | Native image read + verified | Version/model/date |
| --- | --- | --- | --- | --- |
| Codex | Not tested | Not tested | Not tested | Record locally |
| Cursor | Not tested | Not tested | Not tested | Record locally |
| ZCode | Not tested | Not tested | Not tested | Record locally |
| TRAE | Not tested | Not tested | Not tested | Record locally |
| WorkBuddy | Not tested | Not tested | Not tested | Record locally |

Use **pass**, **fail**, or **not tested**, and preserve the exact failure. The bundled `check:mcp` is a transport probe, not a client certification. A CLI test also does not certify the same vendor's desktop app.

## Image fallback and recovery

Agent Hand returns the standard MCP `ImageContent` shape (`type:image`, PNG MIME type, base64 data), alongside text metadata. See the [MCP tool result specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#image-content).

If a client rejects image results, set `AGENT_HAND_MCP_IMAGES=0` in **that MCP server's environment** and restart its MCP process. Agent Hand then returns text metadata with `imageDelivery:text-only` and an explicit warning. Use the client's image-viewing tool on the saved PNG if available. This permits text/ref operation but does not add native vision support to the client.

If clicks are delivered but the page does not change, inspect a fresh observation and the active dialog before retrying. A `via:synthetic` warning means debugger input was unavailable; use `requireTrusted:true` when that distinction matters. Tab selection and refs are shared by the bridge: run one browser controller at a time.
