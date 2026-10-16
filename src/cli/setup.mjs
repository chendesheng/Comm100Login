import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bridgeConfigDirectory, chromeDataDirectory, NATIVE_HOST, readBridgeConfig, socketPath } from './bridge.mjs';

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const execute = promisify(execFile);

export function windowsLauncher(node, script) {
  const quote = (value) => {
    if (/["\r\n\0]/.test(value)) throw new Error('Invalid native host launcher path.');
    return `"${value.replaceAll('%', '%%')}"`;
  };
  // stdout must contain only binary native-messaging frames. Disable expansion of !
  // in paths, escape literal %, and use UTF-8 for non-ASCII installation directories.
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n${quote(node)} ${quote(script)}\r\n`;
}

export async function installBridge(database, state, {
  configDirectory = bridgeConfigDirectory(), chromeDirectory = chromeDataDirectory(),
  os = platform(), runCommand = execute
} = {}) {
  const windows = os === 'win32';
  const extensionId = basename(database);
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('--db must identify the installed Chrome extension directory for setup.');
  socketPath(state.cliBridgeId, os); // Validate before writing any setup files.
  const configFile = join(configDirectory, 'bridge.json');
  const config = await readBridgeConfig(configFile);
  const profilePath = dirname(dirname(database));
  const connections = config.connections.filter((entry) => entry.profilePath !== profilePath);
  connections.push({ profilePath, database, extensionId, bridgeId: state.cliBridgeId });
  const directory = configDirectory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const launcher = join(directory, windows ? 'native-host.bat' : 'native-host');
  const script = fileURLToPath(new URL('../../bin/comm100-accounts-host.mjs', import.meta.url));
  await writeFile(launcher, windows ? windowsLauncher(process.execPath, script)
    : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o700 });
  if (!windows) await chmod(launcher, 0o700);
  const manifestDirectory = windows ? directory : join(chromeDirectory, 'NativeMessagingHosts');
  await mkdir(manifestDirectory, { recursive: true });
  const manifest = {
    name: NATIVE_HOST, description: 'Comm100 account CLI bridge', path: launcher, type: 'stdio',
    allowed_origins: [...new Set(connections.map((entry) => `chrome-extension://${entry.extensionId}/`))]
  };
  const manifestPath = join(manifestDirectory, `${NATIVE_HOST}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  if (windows) {
    // Chrome checks the 32-bit registry view first, even on 64-bit Windows.
    // HKCU needs no administrator privileges; execFile avoids shell interpolation.
    const registry = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    try {
      await runCommand(registry, ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST}`,
        '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', '/reg:32'], { windowsHide: true });
    } catch (error) {
      throw new Error('Cannot register the Chrome native host for this Windows user. Run comm100-accounts setup again.', { cause: error });
    }
  }
  const temporary = `${configFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ connections }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, configFile);
}
