import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const destination = new URL('extension/', root);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
manifest.version = metadata.version;

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
