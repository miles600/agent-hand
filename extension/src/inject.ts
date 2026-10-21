import { collapseOverlays, installPageApi, type PageApi } from './page.js';

type Globals = typeof globalThis & {
  __agentHandInstalled?: boolean;
  __agentHand?: PageApi;
};

// Re-evaluating this script (CDP attach, navigation) must not add another cursor.
collapseOverlays();
const globals = globalThis as Globals;
if (!globals.__agentHandInstalled) {
  globals.__agentHandInstalled = true;
  globals.__agentHand = installPageApi();
}
