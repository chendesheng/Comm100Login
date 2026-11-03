import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const destination = new URL('extension/', root);
const manifestPath = new URL('manifest.json', root);
const manifestSource = await readFile(manifestPath, 'utf8');
const manifest = JSON.parse(manifestSource);
const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (manifest.version !== metadata.version) {
  manifest.version = metadata.version;
  // Keep both the source checkout and the packaged extension on the npm package version.
  await writeFile(manifestPath, manifestSource.replace(/("version"\s*:\s*")[^"]+(")/,
    (_match, prefix, suffix) => `${prefix}${metadata.version}${suffix}`));
}

// Only browser runtime files belong in the unpacked extension. In particular, do not copy
// node_modules, CLI code, account exports, development tools, or local browser state.
await rm(destination, { recursive: true, force: true });
await mkdir(new URL('src/', destination), { recursive: true });
for (const directory of ['background', 'content', 'shared', 'popup']) {
  await cp(new URL(`src/${directory}/`, root), new URL(`src/${directory}/`, destination), { recursive: true });
}
await mkdir(new URL('src/icons/', destination), { recursive: true });
for (const filename of Object.values(manifest.icons)) {
  await cp(new URL(filename, root), new URL(filename, destination));
}
await writeFile(new URL('manifest.json', destination), JSON.stringify(manifest, null, 2) + '\n');
