# Agent Hand

Agent Hand lets a local AI agent drive the Chrome window you already use. The agent gets a compact list of the buttons, links, and fields on the page. When it clicks or types, a cursor overlay glides to the target, and Chrome delivers the input through the debugger protocol so the page sees a trusted event. You watch it happen. The yellow “started debugging this browser” bar is part of that; it is not hidden.

The bridge listens on `127.0.0.1` only. The extension will not connect until you paste a token the bridge generates on first run.

## What you run

- **Chrome extension** (`extension/dist`). Draws the cursor and performs the actions.
- **Bridge** (`agent-hand serve`). WebSocket server for the extension, plus the demo page.
- **MCP** (`agent-hand mcp`) and **CLI** (`agent-hand click 12`). Both talk to that bridge, so Codex, Cursor, Pi, or a shell can drive the same Chrome.

If the bridge is not already running, `agent-hand mcp` starts it. A second process attaches to the one that is already listening.

## macOS setup

You need Node.js 20 or newer and Chrome.

```bash
git clone <this-repo> agent-hand
cd agent-hand
npm install
npm run build
```

Load the extension:

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Choose Load unpacked and select the `extension/dist` folder (the built folder, not `extension/src`).

Start the bridge:

```bash
node dist/bridge/index.js serve
```

The first run prints a token and writes it to `~/.agent-hand/config.json` (mode `0600`). Click the Agent Hand toolbar icon, paste the port (`17321` unless you changed it) and the token, then choose Save and connect. The badge turns **ON**.

Use `127.0.0.1`, not `localhost`. The bridge is IPv4 loopback only, and on macOS `localhost` often resolves to IPv6 first.

Show the token again later with:

```bash
node dist/bridge/index.js token
```

`npm link` (or `npx agent-hand` from this directory) puts the `agent-hand` command on your path. The examples below call the built file directly so the path is obvious.

## Two-minute demo

Leave the bridge running. In Chrome, open the demo page:

```text
http://127.0.0.1:17321/demo
```

The big button ignores ordinary `element.click()` calls. Use the “Dispatch a script click” button if you want to see an untrusted click get rejected. Keep the window visible; the overlay cursor is drawn inside the page.

In a second terminal:

```bash
node dist/bridge/index.js snapshot
```

The JSON `text` field looks like this:

```text
viewport 1200x900 dpr 2
[1] button "Count trusted clicks" (28,120 280x64)
[2] button "Dispatch a script click" (28,210 220x40)
[3] textbox "Your name" (28,280 220x40)
```

Refs are numbered from the top of the viewport. They stay valid until the next snapshot. Use the ref next to the control you want, not a memorized number. Then:

```bash
node dist/bridge/index.js click 1
node dist/bridge/index.js type 3 "Ada Lovelace" --submit
node dist/bridge/index.js screenshot
```

You should see the blue cursor travel to the button, a ripple, and the line “Trusted clicks: 1”. Chrome’s yellow bar appears the first time the debugger attaches. Leave it. Closing DevTools on that tab is required if you had them open; Chrome allows only one debugger.

`screenshot` writes a PNG under `~/.agent-hand/screenshots` and prints the path. Boxes in the snapshot are CSS pixels. The image is CSS pixels times `devicePixelRatio`.

Scroll the buried button into view and click it:

```bash
node dist/bridge/index.js scroll down 800
node dist/bridge/index.js snapshot
node dist/bridge/index.js click <ref for Buried button>
```

## CLI

```text
agent-hand serve [--port 17321]
agent-hand mcp [--port 17321]
agent-hand token
agent-hand status
agent-hand list-tabs
agent-hand select-tab <tabId>
agent-hand navigate <url>
agent-hand snapshot
agent-hand click <ref>
agent-hand type <ref> <text> [--submit]
agent-hand press <key>
agent-hand scroll <up|down|left|right|ref> [amount]
agent-hand screenshot [--out <path>]
agent-hand text [--max <n>]
agent-hand wait <ms>
```

`press` accepts `Enter`, `Tab`, `Escape`, arrows, `Backspace`, `Space`, a single character, and chords such as `Ctrl+A` or `Shift+Tab`. `type` appends; it does not clear the field. `scroll 12` scrolls that ref into view. `scroll down 800` turns the mouse wheel.

Commands print JSON on stdout. Errors go to stderr.

## Cursor and Codex

Start nothing yourself if you want the MCP process to own the bridge. Paste the token into the extension once; the same `~/.agent-hand/config.json` is shared.

Cursor, project `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-hand": {
      "command": "node",
      "args": ["/absolute/path/to/agent-hand/dist/bridge/index.js", "mcp"]
    }
  }
}
```

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.agent-hand]
command = "node"
args = ["/absolute/path/to/agent-hand/dist/bridge/index.js", "mcp"]
```

Pi and other shell agents can skip MCP and run the CLI. The tools are `list_tabs`, `select_tab`, `navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `screenshot`, `get_text`, and `wait`.

## How a click works

1. The service worker keeps a WebSocket to `ws://127.0.0.1:<port>` and reconnects on its own. An alarm wakes the Manifest V3 worker if Chrome suspends it.
2. `snapshot` asks each frame for visible links, buttons, fields, and a few ARIA roles. Same-origin iframes are positioned through `frameElement`. Cross-origin iframes are matched from the parent by URL. That second path is best-effort.
3. `click` scrolls the target into view, moves the overlay (about 700ms), then sends `Input.dispatchMouseEvent`. Coordinates are CSS pixels, the same space as `getBoundingClientRect`. They are not multiplied by the device pixel ratio.
4. `type` clicks, focuses, then `Input.insertText`. `submit` adds Enter.
5. The overlay is `pointer-events: none` and sits at the top of the stacking order, including after a SPA replaces the document body.

File inputs are left out of the snapshot so a click cannot pop a file dialog and stall the browser.

## Security

- The HTTP and WebSocket servers bind to `127.0.0.1` only.
- The first message on a socket must be the shared token. The comparison is timing-safe.
- Browser origins other than `chrome-extension://` are rejected, so a web page cannot open the control socket.
- The token file is mode `0600` in a mode `0700` directory. Override the directory with `AGENT_HAND_HOME`, the token with `AGENT_HAND_TOKEN`, and the port with `AGENT_HAND_PORT` or `--port`.
- Screenshots are mode `0600`. They can contain whatever was on the tab.

Anyone who can read the token can drive this Chrome while the extension is connected. That is the point of the tool, and it is also why the token stays on the machine.

For unattended tests, the extension reads `extension/dist/dev-config.json` when no token is saved yet:

```json
{ "port": 17321, "token": "..." }
```

That file is not part of the build. Do not put a real token in a folder you sync.

## Development

```bash
npm install
npx playwright install chromium
npm test
npm run test:e2e
```

`npm test` builds the bridge and the extension, then runs the protocol, snapshot, and MCP checks. `npm run test:e2e` launches Playwright’s Chromium with the unpacked extension, clicks the demo page through the bridge, and checks that only trusted clicks change the counter. Playwright is not attached to the tab: Chrome allows one debugger, and the extension needs it.

The end-to-end test needs a display (`DISPLAY` on Linux). It does not run in headless Chrome, because the cursor has to be on a real window.
