import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function extensionPath() {
  for (const relative of ['../../extension/manifest.json', '../../manifest.json']) {
    const manifest = new URL(relative, import.meta.url);
    if (existsSync(manifest)) return dirname(fileURLToPath(manifest));
  }
  throw new Error('Chrome extension files are missing. Reinstall @chendesheng/comm100-auto-login.');
}
