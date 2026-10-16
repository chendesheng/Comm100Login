import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bridgeConfigDirectory, chromeDataDirectory, NATIVE_HOST, readBridgeConfig, socketPath } from './bridge.mjs';

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function installBridge(database, state, { configDirectory = bridgeConfigDirectory(), chromeDirectory = chromeDataDirectory() } = {}) {
  if (platform() === 'win32') throw new Error('Native CLI bridge setup currently supports macOS and Linux.');
  const extensionId = basename(database);
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error('--db must identify the installed Chrome extension directory for setup.');
  socketPath(state.cliBridgeId); // Validate before writing any setup files.
  const configFile = join(configDirectory, 'bridge.json');
  const config = await readBridgeConfig(configFile);
  const profilePath = dirname(dirname(database));
  const connections = config.connections.filter((entry) => entry.profilePath !== profilePath);
  connections.push({ profilePath, database, extensionId, bridgeId: state.cliBridgeId });
  const directory = configDirectory;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const launcher = join(directory, 'native-host');
  const script = fileURLToPath(new URL('../../bin/comm100-accounts-host.mjs', import.meta.url));
  await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(script)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  const manifestDirectory = join(chromeDirectory, 'NativeMessagingHosts');
  await mkdir(manifestDirectory, { recursive: true });
  const manifest = {
    name: NATIVE_HOST, description: 'Comm100 account CLI bridge', path: launcher, type: 'stdio',
    allowed_origins: [...new Set(connections.map((entry) => `chrome-extension://${entry.extensionId}/`))]
  };
  await writeFile(join(manifestDirectory, `${NATIVE_HOST}.json`), JSON.stringify(manifest, null, 2) + '\n');
  const temporary = `${configFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ connections }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, configFile);
}
