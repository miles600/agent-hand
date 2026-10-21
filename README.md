# Agent Hand

Agent Hand lets a local AI agent drive a real browser window with a cursor you can see. The same commands work on three kinds of target:

1. **Chrome pages** you already have open, through the extension.
2. **Mobile H5** (uni-app, Vue, and similar) running in that Chrome, including a phone-sized viewport.
3. **Electron or Chromium desktop apps**, by attaching the bridge straight to the app's DevTools port.

The agent gets a compact list of the buttons, links, and fields. When it clicks or types, one cursor overlay glides to the target. Chrome delivers the input through the debugger protocol when it can, so the page sees a trusted event. You watch it happen. The yellow “started debugging this browser” bar is part of that; it is not hidden.

The bridge listens on `127.0.0.1` only. The extension will not connect until you paste a token the bridge generates on first run. Attaching to Electron does not replace that token.

## What you run

- **Chrome extension** (`extension/dist`). Draws the cursor and performs the actions in Chrome.
- **Bridge** (`agent-hand serve`). WebSocket server for the extension, plus the demo page. It also holds a direct DevTools connection when you attach to Electron.
- **MCP** (`agent-hand mcp`) and **CLI** (`agent-hand click 12`). Both talk to that bridge, so Codex, Cursor, Pi, or a shell can drive the same target.

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

## Windows setup

You need Node.js 20 or newer and Chrome. In PowerShell, from the repo:

```powershell
npm install
npm run build
node dist\bridge\index.js serve
```

Load the unpacked extension from `extension\dist` the same way as on macOS (`chrome://extensions`, Developer mode, Load unpacked).

The token file is `%USERPROFILE%\.agent-hand\config.json`. Show it again with:

```powershell
node dist\bridge\index.js token
```

Paste the token into the extension options page. Use `127.0.0.1`, not `localhost`. After you rebuild the extension, reload it without restarting Chrome:

```powershell
node dist\bridge\index.js reload-extension
```

The badge drops and comes back when the service worker reconnects. Reload the page under test if a content script changed.

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

You should see one blue cursor travel to the button, a ripple, and the line “Trusted clicks: 1”. Chrome’s yellow bar appears the first time the debugger attaches. Leave it.

`screenshot` writes a PNG under `~/.agent-hand/screenshots` (`%USERPROFILE%\.agent-hand\screenshots` on Windows) and prints the path. Boxes in the snapshot are CSS pixels. The image is CSS pixels times `devicePixelRatio`.

Scroll the buried button into view and click it:

```bash
node dist/bridge/index.js scroll down 800
node dist/bridge/index.js snapshot
node dist/bridge/index.js click <ref for Buried button>
```

## CLI

```text
agent-hand serve [--port 17321] [--cdp http://127.0.0.1:9222]
agent-hand mcp [--port 17321]
agent-hand token
agent-hand status
agent-hand attach <http://127.0.0.1:port>
agent-hand detach
agent-hand list-tabs
agent-hand select-tab <tabId>
agent-hand navigate <url>
agent-hand snapshot
agent-hand click <ref>
agent-hand click-xy <x> <y>
agent-hand locate <text>
agent-hand type <ref> <text> [--submit]
agent-hand press <key>
agent-hand scroll <up|down|left|right|ref> [amount]
agent-hand emulate <iphone|pixel|off|width height>
agent-hand screenshot [--out <path>]
agent-hand text [--max <n>]
agent-hand console [--clear] [--max <n>]
agent-hand network-errors [--clear] [--max <n>]
agent-hand reload-extension
agent-hand wait <ms>
```

`press` accepts `Enter`, `Tab`, `Escape`, arrows, `Backspace`, `Space`, a single character, and chords such as `Ctrl+A` or `Shift+Tab`. `type` appends; it does not clear the field. `scroll 12` scrolls that ref into view. `scroll down 800` turns the mouse wheel.

`click-xy` is CSS pixels in the viewport, the same space as the boxes in `snapshot`. `locate` returns center points for visible text so you can click a label that is not a normal button.

Commands print JSON on stdout. Errors go to stderr. A click or type result includes `via`: `trusted` when the debugger delivered the event, or `synthetic` when the page received DOM events instead.

While a direct DevTools session is attached, these commands drive that app. `detach` closes only the debugger socket and later commands go back to the Chrome extension. `reload-extension` always talks to the extension.

## Mobile H5 (uni-app and Vue)

Open the H5 build in Chrome like any other page (a dev server URL is fine). The snapshot lists normal controls and uni-app elements: `uni-button`, `uni-checkbox`, `uni-radio`, `uni-switch`, `uni-picker`, `uni-navigator`, `uni-label`, `.uni-select`, checklist rows, `[onclick]`, and the outermost element with `cursor: pointer`. Up to 300 controls are listed.

```bash
node dist/bridge/index.js emulate iphone
node dist/bridge/index.js snapshot
node dist/bridge/index.js locate 登录
node dist/bridge/index.js click-xy 180 420
node dist/bridge/index.js type <ref> "13800000000"
```

`emulate iphone` is 390×844 CSS pixels at device scale 3, with touch emulation and a mobile user agent. `emulate pixel` is 412×915. `emulate 390 844` is a custom size. `emulate off` clears the override. Touch clicks fall back to pointer and touch DOM events when the debugger does not deliver them, so Vue `@click` handlers still run.

You can leave DevTools docked on the tab. In that state Chrome accepts the debugger attachment but does not acknowledge `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, or `Input.insertText`, so each trusted attempt stops after 2.5 seconds. Agent Hand does **not** detach the debugger on that timeout (detaching makes the next command fail with “Debugger is not attached”). It sends DOM events instead and reports `"via": "synthetic"`. If the click had to fall back, the following `type` writes the field with the native value setter plus `input` and `change`, which updates Vue `v-model`. `press` and `scroll` fall back the same way.

Synthetic events are `isTrusted: false`. The demo page's trusted-click counter will not move while DevTools is open. Close DevTools when you need a trusted click. H5 apps that listen for normal clicks and input events work with the fallback.

`console` and `network-errors` are there for the test report. Console capture includes messages the page script sees and debugger `Runtime` events. Network failures (and HTTP status 400 and above) start when the debugger attaches, which is the first click, emulate, or `network-errors` call. Pass `--clear` to drop the buffer.

## Electron and other Chromium apps

The extension cannot see an Electron window. Start the app with a loopback DevTools port and attach the bridge. On Windows:

```powershell
my-app.exe --remote-debugging-port=9222
node dist\bridge\index.js attach http://127.0.0.1:9222
node dist\bridge\index.js list-tabs
node dist\bridge\index.js select-tab <id from list-tabs>
node dist\bridge\index.js snapshot
node dist\bridge\index.js click 1
```

On macOS or Linux the flags are the same (`--remote-debugging-port=9222`). You can also start the bridge already attached:

```bash
node dist/bridge/index.js serve --cdp http://127.0.0.1:9222
```

Or pass `--cdp` on a single command. The bridge connects to the page's debugger socket only. It does not call `Browser.close`, `Target.closeTarget`, or `Page.close`, and it does not navigate unless you run `navigate`. `detach` (or stopping the bridge) closes the socket and leaves the app running. `navigate` still allows only `http` and `https` URLs; leave the app on its own page and click from there.

The commands above are the same as in Chrome, including `click-xy`, `locate`, `emulate`, `console`, `network-errors`, and `screenshot`. The cursor overlay is injected into the page. Target ids from `list-tabs` are strings. Chrome tab ids stay numbers.

A Chrome you started yourself with `--remote-debugging-port` can be driven the same way. Do not point `--cdp` at anything but loopback.

## Cursor and Codex

Start nothing yourself if you want the MCP process to own the bridge. Paste the token into the extension once; the same `~/.agent-hand/config.json` is shared. On Windows that file is under `%USERPROFILE%\.agent-hand\`.

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

Pi and other shell agents can skip MCP and run the CLI. The tools are `list_tabs`, `select_tab`, `navigate`, `snapshot`, `click`, `click_xy`, `locate`, `type`, `press`, `scroll`, `emulate`, `screenshot`, `get_text`, `console`, `network_errors`, `attach_cdp`, `detach_cdp`, `reload_extension`, and `wait`.

## How a click works

1. The service worker keeps a WebSocket to `ws://127.0.0.1:<port>` and reconnects on its own. An alarm wakes the Manifest V3 worker if Chrome suspends it. In direct mode the bridge holds the DevTools socket instead.
2. `snapshot` asks each frame for visible links, buttons, fields, uni-app controls, and a few ARIA roles. Same-origin iframes are positioned through `frameElement`. Cross-origin iframes are matched from the parent by URL. That second path is best-effort.
3. `click` scrolls the target into view, moves the overlay (about 700ms), then sends `Input.dispatchMouseEvent`. Coordinates are CSS pixels, the same space as `getBoundingClientRect`. They are not multiplied by the device pixel ratio.
4. There is one overlay element per document, `#agent-hand-root`. A second injection removes the previous node instead of stacking another cursor. `click`, `click-xy`, typing, and direct CDP mode all move that same overlay.
5. If `Input.*` does not acknowledge within 2.5 seconds, or the debugger is not attached, the command falls back to DOM events at the same point and leaves the debugger attached. `type` then uses the native value setter when the click was synthetic.
6. The overlay is `pointer-events: none` and sits at the top of the stacking order, including after a SPA replaces the document body.

File inputs are left out of the snapshot so a click cannot pop a file dialog and stall the browser.

## Security

- The HTTP and WebSocket servers bind to `127.0.0.1` only.
- The first message on a socket must be the shared token. The comparison is timing-safe.
- Browser origins other than `chrome-extension://` are rejected, so a web page cannot open the control socket.
- Direct DevTools URLs must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. Page sockets that do not point at loopback are refused.
- The token file is mode `0600` in a mode `0700` directory. Override the directory with `AGENT_HAND_HOME`, the token with `AGENT_HAND_TOKEN`, and the port with `AGENT_HAND_PORT` or `--port`.
- Screenshots are mode `0600`. They can contain whatever was on the tab.
- The content script keeps a short console buffer in the page so `console` works while DevTools is open. It stays on the machine until you run `console`.

Anyone who can read the token can drive this Chrome while the extension is connected. Anyone who can open the DevTools port can drive that Electron app even without Agent Hand. That is the point of the tool, and it is also why both stay on the machine.

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

`npm test` builds the bridge and the extension, then runs the protocol, snapshot, CDP, and MCP checks. `npm run test:e2e` launches Playwright’s Chromium with the unpacked extension, clicks the demo page through the bridge, and checks that only trusted clicks change the counter. Playwright is not attached to the tab: Chrome allows one debugger, and the extension needs it.

The end-to-end test needs a display (`DISPLAY` on Linux). It does not run in headless Chrome, because the cursor has to be on a real window.
