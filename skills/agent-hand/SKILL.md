---
name: agent-hand
description: Operate the user's existing Chrome tabs or a connected Electron app through Agent Hand MCP. Use for browser observation, interaction, verification, and recovery while keeping the current login session.
---

# Agent Hand

Use the configured Agent Hand tools; client prefixes may differ. This is an existing browser with the user's cookies. Keep the task in the intended tab. For a separate test page, use `new_tab({url})` in Chrome extension mode rather than replacing an unrelated tab.

## Observe → act → verify

- Start with `list_tabs`, then `observe({tabId})` on the intended tab. Check URL and title. Add `includeScreenshot:true` for visual layout, canvas, ambiguous controls, or overlays. If `observe` is unavailable, use `select_tab`, `snapshot`, and `screenshot`.
- Choose refs from the latest observation. Prefer refs and labels over coordinates. Re-observe after navigation, scrolling, opening a menu/dialog, or another page change. Another agent's snapshot replaces the shared refs; use one controller at a time.
- Use `fill` to replace a field; `type` appends. For a custom dropdown, open it and observe its options before selecting. Coordinates are viewport CSS pixels; divide screenshot pixels by its reported devicePixelRatio.
- After an action, check the intended result with `wait_for_text`, `wait_for_url`, `observe`, or `get_text`. A delivered click is not evidence that the task succeeded. Use the page's confirmation, changed value, or destination as evidence.

## Recover with fresh evidence

- Wrong/missing ref or no visible change: observe again, confirm tab and overlays, then choose a fresh target. Do not repeat a submit/payment/send action when its outcome is uncertain; inspect the current result first.
- Covered or clipped controls can still appear in a snapshot. Use the screenshot to identify the active dialog or scroll container. Do not click an obscured control just because it has a ref.
- A `via:synthetic` warning means the event was delivered with DOM events. If trusted input matters, use `requireTrusted:true`; close DevTools if it blocks the debugger, then retry after observation.
- Extension disconnected: check that the extension is enabled and its token/port match the bridge. Reload the extension when needed, then wait for reconnection. An existing bridge is reused by MCP; do not start duplicate bridges or kill unrelated processes.
- If an evidence-based retry fails, report the exact error and observed state instead of guessing or looping. Preserve existing authorization; recovery does not authorize a new external action.

## Verify images reach this client

`screenshot` and `observe({includeScreenshot:true})` return MCP image content plus PNG metadata. A file path or base64 text alone does not mean the model saw an image. If no image is visible to the model, use the client's image-viewing tool on the PNG and report that fallback. Without an image viewer, use refs/text and report the visual limitation.

To test native image support, open the bridge's `/demo/vision.html` in a designated test tab. Read the canvas code from MCP image content, fill it, click **Verify code**, then verify **PASS: visual code matched.** Do not open the PNG, inspect page source, or use another browser tool during this native-image test. Record client/version/model and whether native image or file-viewer fallback passed. Never infer compatibility from tool discovery alone.
