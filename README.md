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

`screenshot` returns native MCP image content alongside the PNG file metadata. Clients must forward that image to the model; a file path alone does not provide vision. The CLI writes a PNG under `~/.agent-hand/screenshots` (`%USERPROFILE%\.agent-hand\screenshots` on Windows) and prints the path. Boxes in the snapshot are CSS pixels. When the debugger is attached, the PNG is the emulated viewport: `cssWidth * devicePixelRatio` by `cssHeight * devicePixelRatio`, clipped with `Page.captureScreenshot` so the white margin and the browser chrome are not in the file. `captureVisibleTab` is only the fallback when the debugger is not attached, and `devicePixelRatio` is then the scale of that image.

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
agent-hand timeline
agent-hand attach <http://127.0.0.1:port>
agent-hand detach
agent-hand list-tabs
agent-hand select-tab <tabId>
agent-hand new-tab <url>
agent-hand navigate <url>
agent-hand observe [--screenshot]
agent-hand snapshot
agent-hand click <ref>
agent-hand click-xy <x> <y>
agent-hand hover <ref>
agent-hand hover-xy <x> <y>
agent-hand dblclick <ref>
agent-hand dblclick-xy <x> <y>
agent-hand right-click <ref>
agent-hand right-click-xy <x> <y>
agent-hand locate <text>
agent-hand type <ref> <text> [--submit]
agent-hand clear <ref>
agent-hand fill <ref> <text> [--submit]
agent-hand select <ref> <value-or-label>
agent-hand press <key>
agent-hand scroll <up|down|left|right|ref> [amount]
agent-hand emulate <iphone|pixel|off|390x844|390x844@3|width height [dpr]> [--fit-window]
agent-hand --require-trusted click <ref>
agent-hand screenshot [--out <path>]
agent-hand text [--max <n>]
agent-hand console [--clear] [--max <n>]
agent-hand network-errors [--clear] [--max <n>]
agent-hand reload-extension
agent-hand wait <ms>
agent-hand wait-for text <substring> [--timeout <ms>]
agent-hand wait-for url <substring|/pattern/> [--timeout <ms>]
agent-hand wait-for idle [--timeout <ms>]
```

`dblclick` is also `double-click`. `right-click` is also `context-click`. The xy forms accept `double-click-xy` and `context-click-xy` too.

`press` accepts `Enter`, `Tab`, `Escape`, arrows, `Backspace`, `Space`, a single character, and chords such as `Ctrl+A` or `Shift+Tab`. `type` appends; it does not clear the field. `fill` clears the field, then inserts. `clear` empties an input, textarea, or contenteditable. `scroll 12` scrolls that ref into view. `scroll down 800` turns the mouse wheel.

`click-xy` is CSS pixels in the viewport, the same space as the boxes in `snapshot`. `locate` returns center points for visible text so you can click a label that is not a normal button.

`hover` moves the cursor and sends `Input.dispatchMouseEvent` `mouseMoved`. It does not click. `dblclick` sends a left press and release with `clickCount` 1, then again with `clickCount` 2. `right-click` uses the right button. A trusted right-click can open the browser context menu unless the page cancels `contextmenu`. Hover and right-click stay mouse events even when touch emulation is on. If DevTools holds the debugger, these fall back to DOM events the same way `click` does (`via: "synthetic"`, plus `warning`). `--require-trusted` fails instead.

`clear` and `fill` focus the field with a click. On the trusted path they select the contents and press Backspace; `fill` then uses `Input.insertText`. On the synthetic path they set the value with the native setter and dispatch `input` and `change`, which updates Vue and React controlled inputs. A contenteditable gets `innerText` plus the same events. `type` is unchanged and still appends. Input types that reject `setSelectionRange` (for example `number`) use the synthetic setter unless `--require-trusted` is set.

`select` picks a native `<select>` option by exact value, exact label, or one unique substring. That write is done in the page, so the result is `via: "synthetic"` and `--require-trusted` fails it: the operating-system popup is not a click. For a snapshot combobox, listbox, or option, it clicks a visible `role="option"` or `role="menuitem"` (exact text or `data-value` / `value`, otherwise one unique substring). A ref the snapshot already calls an option is clicked the same way when the label or value matches. A closed combobox is clicked once to open, then the option is clicked. Ambiguous matches fail. Options have to be in the same document as the ref. Closed shadow DOM, canvas widgets, and menus that never expose those roles are not supported.

`wait-for text` polls `innerText`, including same-process iframes, until it contains the substring. `wait-for url` polls `location.href`. A plain string is a substring. A value wrapped in slashes (`/ready/i`) is a regular expression. `wait-for idle` means no Chrome Network request tracked since the debugger attached has been in flight for 500ms. Tracking is the same Network domain as `network-errors`, plus `loadingFinished` and `requestServedFromCache`. It starts when the debugger attaches, so requests that finished earlier are not counted, and a WebSocket or long poll may never go idle. If the debugger cannot attach, idle instead waits until `document.readyState` is `complete` and resource timing is unchanged for 500ms, and the result includes a warning. The default timeout is 10000ms and the maximum is 60000 (`--timeout`, or MCP `timeout`). A timeout throws.

Commands print JSON on stdout. Errors go to stderr. A click or type result includes `via`: `trusted` when the debugger delivered the event, or `synthetic` when the page received DOM events instead. A synthetic result also has `warning`, and the CLI prints that warning on stderr. `status` includes the last viewport reported by `snapshot`, `emulate`, or `screenshot` (`cssWidth`, `cssHeight`, `devicePixelRatio`), so you can check it without parsing the page.

`--require-trusted` makes `click`, `hover`, `dblclick`, `right-click`, their xy forms, `type`, `clear`, `fill`, `press`, `scroll`, and `select` fail instead of falling back to synthetic input. A native `<select>` is changed in the page, so it fails under this flag. The same switch is `AGENT_HAND_REQUIRE_TRUSTED=1` or `"requireTrusted": true` in `config.json`. The default stays the synthetic fallback. MCP accepts `requireTrusted: true` on those tools, and a bridge or `agent-hand mcp` started with the flag applies it to every call.

While a direct DevTools session is attached, these commands drive that app. `detach` closes only the debugger socket and later commands go back to the Chrome extension. `reload-extension` always talks to the extension.

## Mobile H5 (uni-app and Vue)

Open the H5 build in Chrome like any other page (a dev server URL is fine). The snapshot lists normal controls and uni-app elements: `uni-button`, `uni-checkbox`, `uni-radio`, `uni-switch`, `uni-picker`, `uni-navigator`, `uni-label`, `.uni-select`, checklist rows, `[onclick]`, and the outermost element with `cursor: pointer`. A short label in a horizontal row (进度 tabs such as 当期/往期, or 流程中心 tabs such as 我的发起/我的待办/我的完成) gets a `tab` ref even when the node has no role and no `cursor: pointer`. The same goes for `.tab`, `.tabs-item`, `.uni-tab`, `.uni-tabbar__item`, and an element whose Vue vnode has `onClick`. A vertical stack of text is left out, so the list does not fill up with every label. Up to 300 controls are listed.

A disabled or readonly picker field is not listed as a dead textbox. The ref is the clickable wrapper (`uni-picker`, a `uni-date` editor, or the small `uni-view` around it), named from the field value, and a click hits that wrapper. Checkboxes, radios, and switches include `checked` or `unchecked` (native `checked`, `aria-checked`, and uni-app's `uni-checkbox-input-checked` / `uni-radio-input-checked`). Image and card tiles get a ref named from alt text, `aria-label`, the text inside, or the label next to the tile.

For a phone layout with trusted clicks, close DevTools and let Agent Hand emulate. Miles's window with DevTools closed is a desktop viewport (about 1536×735 at 1.25 on a 125% display). DevTools device mode does not survive closing DevTools.

```bash
node dist/bridge/index.js emulate 390x844@3
node dist/bridge/index.js snapshot
node dist/bridge/index.js click 1
```

`emulate iphone` is 390×844 CSS pixels at device scale 3, with touch and a mobile user agent. `emulate pixel` is 412×915 at 2.625. `emulate 390x844` is that size at scale 2 (mobile and touch still on). `emulate 390x844@3` sets the scale to 3. `emulate 390 844` still works. `emulate off` clears it. `emulate 390x844 --fit-window` (MCP `fitWindow: true`) then resizes the real Chrome window so the content area is that CSS size. The emulated page otherwise sits in the corner of the large window with a blank region beside and below it. The resize uses the pre-override gap between `outerWidth`/`outerHeight` and `innerWidth`/`innerHeight`, including the "<extension> started debugging this browser" infobar, and the native `devicePixelRatio` (1.25 at 125% Windows) when `chrome.windows` reports physical pixels. A maximized or fullscreen window is restored to normal first. One correction pass runs if the content box is still off by more than 2 CSS pixels. The result includes `windowBefore`, `windowAfter`, `content`, and `corrected`. `emulate off` puts the previous bounds and state back. This moves the window that holds your other tabs. Without `--fit-window` the window is never moved or resized. The command reads `window.innerWidth`, `innerHeight`, and `devicePixelRatio` back and returns them as `cssWidth`, `cssHeight`, `devicePixelRatio`, plus `applied: true` when they match. `snapshot` starts with the same numbers (`viewport 390x844 dpr 3`). `status` repeats the last reading. Check those before trusting coordinates. The override stays while the extension debugger stays attached, including across a reload of the page. Opening DevTools, or `reload-extension`, drops it.

This extension cannot toggle DevTools' device toolbar. There is no API for that checkbox. Device mode and `Emulation.setDeviceMetricsOverride` write the same override and fight: toolbar on, DevTools wins; toolbar off but DevTools still open, DevTools often clears metrics and the page stays at the real window size. Recommended: close DevTools, run `emulate 390x844@3`, and confirm `applied` and the snapshot line. Use the device toolbar yourself only when you are watching and you do not need `isTrusted`. Undocking DevTools does not give you a trusted click.

With DevTools open, docked or in another window, Chrome will not give this extension the debugger. Undocked, `chrome.debugger.attach` is refused immediately (`Another debugger is already attached`). The extension still tries `Input.*`, which fails at once with `Debugger is not attached` — it does not wait 2.5 seconds. Docked DevTools sometimes lets attach succeed and then never acknowledges `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, or `Input.insertText`, so that attempt stops after 2.5 seconds. Agent Hand does **not** detach on that timeout. The default is to send DOM events and return `"via": "synthetic"` plus `warning`. `type` then uses the native value setter plus `input` and `change`, which updates Vue `v-model`. `press` and `scroll` fall back the same way. Synthetic events are `isTrusted: false`. Pass `--require-trusted` when a test must fail instead of accepting that.

Touch fallback sends `pointerdown`, `touchstart`, `pointerup`, `touchend`, and `click`. It does not also send `mousedown` / `mouseup`. The mouse fallback sends `pointerdown`, `mousedown`, `pointerup`, `mouseup`, and `click`, and does not send touch events.

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

Pi and other shell agents can skip MCP and run the CLI. The tools are `list_tabs`, `select_tab`, `new_tab`, `navigate`, `observe`, `snapshot`, `click`, `hover`, `dblclick`, `right_click`, and the `_xy` forms of those, `locate`, `type`, `clear`, `fill`, `select`, `press`, `scroll`, `emulate`, `screenshot`, `get_text`, `console`, `network_errors`, `attach_cdp`, `detach_cdp`, `reload_extension`, `wait`, `wait_for_text`, `wait_for_url`, and `wait_for_idle`.

## Observe, verify, and check client compatibility

Use `observe({tabId, includeScreenshot:true})` to select an existing tab and return a fresh snapshot plus screenshot in one queued bridge operation. Snapshot metadata includes the tab ID, URL, title, and viewport. Other bridge commands cannot interleave those captures; the page can still animate between them. Omit `includeScreenshot` for a cheaper text observation. CLI: `agent-hand observe [--screenshot]` after selecting a tab.

Load the small [Agent Hand Skill](skills/agent-hand/SKILL.md) to guide observation, action, verification, and recovery. For Codex, copy the `skills/agent-hand` folder into `~/.codex/skills/`. Other agents can use their Skill loader or project instructions. The MCP initialize response also carries the essential workflow.

Run `npm run check:mcp` for protocol/tool discovery, or `npm run check:mcp -- --tab <test-tab-id>` to also verify native PNG delivery. Follow the [client compatibility guide](docs/client-compatibility.md) for a canvas-based visual test in Codex, Cursor, ZCode, TRAE, or WorkBuddy. The transport probe never claims that another client's model saw the image. Use `AGENT_HAND_MCP_IMAGES=0` only for clients that require text-only results.

## Operation timeline and human takeover

Run `node dist/bridge/index.js timeline`, or call the MCP `timeline` tool, to get a one-use local timeline link. Open it within 60 seconds to connect automatically. The dashboard is at `http://127.0.0.1:17321/timeline` (use your configured port); after a bridge restart, reopen it from the command or connect with your existing extension token.

The timeline shows the target tab and URL, action and control name, status, duration, result or failure, and screenshots after browser actions. Dashboard inspection activity is filtered out of the displayed history, and the list stays stable while you interact with its entries. Automatic screenshot capture can be disabled in the dashboard. The latest 100 records and up to 64 MB of timeline screenshots are kept privately under `~/.agent-hand/timeline`; history survives restarts and can be cleared in the dashboard. Typed values and URL query values are masked in metadata. Screenshots retain the visible page content.

**Stop and take over** cancels queued actions, interrupts bridge waits, and blocks new browser commands. An action already sent to Chrome may finish and cannot be undone: the dashboard shows that it is still finishing and disables resume until the bridge receives its result. Automatic evidence capture stops during takeover. **Return to Agent** allows new requests; cancelled actions are never replayed. The agent must observe the page again before continuing. Takeover remains in effect across bridge restarts, and interrupted history is marked with an unknown outcome.

Queued requests also expire at their original deadline, so a client timeout does not leave a click waiting to run later. The timeline uses a separate authenticated control path, so stopping remains available while the browser command queue is busy.

## How a click works

1. The service worker keeps a WebSocket to `ws://127.0.0.1:<port>` and reconnects on its own. An alarm wakes the Manifest V3 worker if Chrome suspends it. In direct mode the bridge holds the DevTools socket instead.
2. `snapshot` asks each frame for visible links, buttons, fields, uni-app controls, and a few ARIA roles. Same-origin iframes are positioned through `frameElement`. Cross-origin iframes are matched from the parent by URL. That second path is best-effort.
3. `click` scrolls the target into view, moves the overlay (about 700ms), then sends `Input.dispatchMouseEvent`. Coordinates are CSS pixels, the same space as `getBoundingClientRect`. They are not multiplied by the device pixel ratio.
4. There is one overlay element per document, `#agent-hand-root`. A second injection removes the previous node instead of stacking another cursor. `click`, `click-xy`, typing, and direct CDP mode all move that same overlay.
5. If DevTools is open, trusted input is refused. Undocked DevTools fails immediately (attach is rejected, then `Input.*` returns "not attached"). Docked DevTools may instead let attach succeed and leave `Input.*` unanswered for 2.5 seconds. The default is DOM events at the same point, with `via: "synthetic"` and a `warning`, and the debugger is left attached. `--require-trusted` throws instead. `type` uses the native value setter when the click was synthetic.
6. The overlay is `pointer-events: none` and sits at the top of the stacking order, including after a SPA replaces the document body.

File inputs are left out of the snapshot so a click cannot pop a file dialog and stall the browser.

## Security

- The HTTP and WebSocket servers bind to `127.0.0.1` only.
- The first message on a socket must be the shared token. The comparison is timing-safe.
- Browser origins other than `chrome-extension://` are rejected, so a web page cannot open the control socket.
- Direct DevTools URLs must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. Page sockets that do not point at loopback are refused.
- The token file is mode `0600` in a mode `0700` directory. Those modes are applied when the directory or file is created. A later read does not chmod, and a chmod that fails (EPERM in a sandbox) does not fail the command. Override the directory with `AGENT_HAND_HOME`, the token with `AGENT_HAND_TOKEN`, the port with `AGENT_HAND_PORT` or `--port`, and trusted-only input with `AGENT_HAND_REQUIRE_TRUSTED=1` or `"requireTrusted": true` in the config file.
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

### Browser recovery and macOS foreground

For a visible Chrome session on macOS, call `select_tab({tabId, foreground:true})` or `observe({tabId, foreground:true, includeScreenshot:true})`. The result includes `foreground.frontmost`, verified against the macOS foreground application. This is opt-in; ordinary background observation does not activate Chrome at the OS level. Other platforms report unsupported native activation, and CDP/Electron mode rejects this Chrome-specific option.

Empty main-frame snapshots retry for up to 600 ms to allow fading overlays to expose controls. Generic clickable containers are omitted when their descendants already have actionable references. Content-channel transitions retry observations and cursor feedback at most twice; page mutations are never replayed automatically. After a navigation click, wait for the destination URL before checking text shared with the old page.

Timeline URL-derived headings use the same query/fragment/credential redaction as URL lines, including records loaded from earlier versions. Screenshots still contain the visible page.
