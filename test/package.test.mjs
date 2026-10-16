import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('npm archive contains a complete extension and prints its installed path without Chrome', async (t) => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'comm100-package-')));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await execute(process.execPath, ['scripts/build-extension.mjs'], { cwd: root });
  const { stdout } = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary,
    '--cache', join(temporary, 'cache')], { cwd: root });
  const [packed] = JSON.parse(stdout);
  assert.equal(packed.name, '@chendesheng/comm100-auto-login');
  const paths = new Set(packed.files.map((file) => file.path));
  assert(![...paths].some((path) => /^(?:test|tools|node_modules|\.github)\//.test(path)));
  assert(!paths.has('src/icons/icon.png')); // The large design source is not a browser runtime asset.
  await execute('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary]);
  const installed = join(temporary, 'package');
  const extension = join(installed, 'extension');
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, packed.version);
  for (const path of [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap((entry) => entry.js)]) {
    assert((await stat(join(extension, path))).isFile(), `Missing manifest resource: ${path}`);
  }
  // Check every relative ES module import in the archive, including the worker's shared modules
  // and the native host entry point. This catches missing files that a source-tree test can hide.
  for (const path of paths) {
    if (!/\.m?js$/.test(path)) continue;
    const source = await readFile(join(installed, path), 'utf8');
    for (const [, relative] of source.matchAll(/(?:from\s+|import\s*)['"](\.[^'"]+)['"]/g)) {
      assert((await stat(resolve(installed, dirname(path), relative))).isFile(), `${path} imports missing ${relative}`);
    }
  }
  const html = await readFile(join(extension, manifest.action.default_popup), 'utf8');
  for (const [, path] of html.matchAll(/(?:src|href)="(\.[^"]+)"/g)) {
    assert((await stat(resolve(extension, dirname(manifest.action.default_popup), path))).isFile());
  }
  const { stdout: message } = await execute(process.execPath, ['scripts/postinstall.mjs'], { cwd: installed });
  assert(message.includes(extension));
  assert(message.includes('chrome://extensions'));
  assert(message.includes('Load unpacked'));
  const { stdout: actualPath } = await execute(process.execPath, ['--input-type=module', '-e',
    "import { extensionPath } from './src/cli/extension-path.mjs'; console.log(extensionPath());"], { cwd: installed });
  assert.equal(actualPath.trim(), extension);
});
