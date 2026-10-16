import * as store from '../shared/storage.js';
import { tokenIsFresh } from '../shared/tokens.js';

export const NATIVE_HOST = 'com.comm100.accounts';
const ALARM = 'comm100-cli-bridge';

/** Only invoked over the native port, never through page/content-script messaging. */
export async function handleCliRequest(request) {
  switch (request?.type) {
    case 'getState':
      return { state: await store.getState() };
    case 'saveToken':
      if (!tokenIsFresh(request.token)) throw new Error('Cannot cache an expired or invalid JWT.');
      return { token: await store.saveToken(request.token) };
    default:
      throw new Error('Unknown CLI bridge request.');
  }
}

export function startCliBridge() {
  if (!chrome.runtime.connectNative) return;
  let port = null;
  let connecting = false;
  async function connect() {
    if (port || connecting) return;
    connecting = true;
    try {
      const bridgeId = await store.ensureCliBridgeId();
      const current = chrome.runtime.connectNative(NATIVE_HOST);
      port = current;
      current.onDisconnect.addListener(() => {
        // Read lastError so an uninstalled host does not produce an unchecked runtime error.
        void chrome.runtime.lastError;
        if (port === current) port = null;
      });
      current.onMessage.addListener(async (message) => {
        if (!message?.id) return;
        let response;
        try { response = { id: message.id, ok: true, result: await handleCliRequest(message.request) }; }
        catch (error) { response = { id: message.id, ok: false, error: error.message }; }
        try { current.postMessage(response); } catch { /* Host disconnected while the write completed. */ }
      });
      current.postMessage({ type: 'ready', bridgeId });
    } catch { port = null; }
    finally { connecting = false; }
  }
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void connect(); });
  void connect();
}
