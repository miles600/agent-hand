import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep } from '../shared/sleep.js';

const execute = promisify(execFile);
const FRONTMOST = "ObjC.import('AppKit'); ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)";

export type ForegroundResult = { supported: boolean; frontmost: boolean; warning?: string };

/** Explicit foreground requests only: never launch a shell or ask for Accessibility. */
export async function foregroundChrome(
  platform = process.platform,
  run: (file: string, args: string[]) => Promise<{ stdout: string }> = (file, args) => execute(file, args, { timeout: 3000 }),
): Promise<ForegroundResult> {
  if (platform !== 'darwin') return { supported: false, frontmost: false, warning: 'Native foreground activation is currently supported on macOS only.' };
  try {
    await run('/usr/bin/open', ['-b', 'com.google.Chrome']);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', FRONTMOST]);
      if (result.stdout.trim() === 'com.google.Chrome') return { supported: true, frontmost: true };
      if (attempt < 2) await sleep(100);
    }
    return { supported: true, frontmost: false, warning: 'Chrome tab selected, but macOS did not bring Chrome to the foreground. Bring Chrome forward manually.' };
  } catch (error) {
    return { supported: true, frontmost: false, warning: `Chrome tab selected; foreground activation could not be verified: ${error instanceof Error ? error.message : String(error)}` };
  }
}
