const portInput = document.querySelector<HTMLInputElement>('#port');
const tokenInput = document.querySelector<HTMLInputElement>('#token');
const saveButton = document.querySelector<HTMLButtonElement>('#save');
const statusEl = document.querySelector<HTMLElement>('#status');

if (!portInput || !tokenInput || !saveButton || !statusEl) {
  throw new Error('options page is missing controls');
}

const portField = portInput;
const tokenField = tokenInput;
const statusNode = statusEl;

void hydrate();

const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
if (hash.get('port')) portField.value = hash.get('port') ?? portField.value;
if (hash.get('token')) tokenField.value = hash.get('token') ?? '';
if (hash.get('token')) {
  history.replaceState(null, '', location.pathname + location.search);
  void save();
}

saveButton.addEventListener('click', () => {
  void save();
});

window.setInterval(() => {
  void refreshStatus();
}, 1000);

async function hydrate(): Promise<void> {
  const stored = await chrome.storage.local.get(['port', 'token']);
  if (typeof stored.port === 'number') portField.value = String(stored.port);
  if (typeof stored.token === 'string' && stored.token) {
    tokenField.placeholder = 'Token saved — paste a new one to replace';
  }
  await refreshStatus();
}

async function save(): Promise<void> {
  const port = Number(portField.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    setStatus('Port must be an integer from 1 to 65535.', false);
    return;
  }
  const token = tokenField.value.trim();
  if (token.length < 16) {
    setStatus('Paste the full token from the bridge.', false);
    return;
  }
  await chrome.storage.local.set({ port, token });
  tokenField.value = '';
  tokenField.placeholder = 'Token saved — paste a new one to replace';
  chrome.runtime.sendMessage({ source: 'agent-hand', type: 'config-updated' }, () => {
    void chrome.runtime.lastError;
  });
  setStatus('Saved. Connecting…', false);
  window.setTimeout(() => {
    void refreshStatus();
  }, 400);
}

function refreshStatus(): Promise<void> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ source: 'agent-hand', type: 'status' }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        setStatus(err.message ?? 'Extension unavailable', false);
        resolve();
        return;
      }
      const connected = Boolean(response?.connected);
      const detail = typeof response?.error === 'string' ? response.error : '';
      if (connected) setStatus('Connected to the local bridge.', true);
      else setStatus(detail || 'Not connected.', false);
      resolve();
    });
  });
}

function setStatus(text: string, ok: boolean): void {
  statusNode.textContent = text;
  statusNode.style.color = ok ? '#166534' : '#9a3412';
}
