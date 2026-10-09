import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { SvxLanguageBackend } from '../src/language-backend.ts';

test('real Vite language options work without modifying project files or installed dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'svx-read-only-'));
  const toolRoot = fileURLToPath(new URL('..', import.meta.url));
  const require = createRequire(join(toolRoot, 'package.json'));
  mkdirSync(join(root, 'node_modules/@sveltejs'), { recursive: true });
  for (const name of ['svelte', 'vite', '@sveltejs/vite-plugin-svelte']) {
    symlinkSync(resolve(toolRoot, 'node_modules', name), join(root, 'node_modules', name), 'dir');
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true},"include":["**/*.svelte"]}');
  writeFileSync(join(root, 'vite.config.ts'), `
    import { svelte } from '@sveltejs/vite-plugin-svelte';
    import { mkdirSync, writeFileSync } from 'node:fs';
    mkdirSync(new URL('./build-cache', import.meta.url), { recursive: true });
    const config: { plugins: unknown[] } = { plugins: [
      svelte({ compilerOptions: { runes: true } }),
      { name: 'unrelated-build-plugin', configResolved() {
        writeFileSync(new URL('./user-file.txt', import.meta.url), 'modified');
      } }
    ] };
    export default config;
  `);
  writeFileSync(join(root, 'user-file.txt'), 'original');
  const serviceFile = join(dirname(require.resolve('svelte-language-server/package.json')), 'dist/src/plugins/typescript/service.js');
  const serviceHash = () => createHash('sha256').update(readFileSync(serviceFile)).digest('hex');
  const originalService = serviceHash();
  function snapshot(directory: string): Record<string, unknown> {
    const entries: Record<string, unknown> = {};
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), stat = lstatSync(path);
      entries[name] = stat.isSymbolicLink() ? { mode: stat.mode, mtime: stat.mtimeMs }
        : stat.isDirectory() ? snapshot(path)
        : { mode: stat.mode, mtime: stat.mtimeMs, hash: createHash('sha256').update(readFileSync(path)).digest('hex') };
    }
    return entries;
  }
  const before = snapshot(root);
  const backend = new SvxLanguageBackend(root);
  try {
    const source = '<script>export let count = 1;</script>\n{count}\n';
    const diagnostics = await backend.diagnose(source, join(root, 'article.svx'));
    assert.ok(diagnostics.some(d => d.code === 'legacy_export_invalid'), JSON.stringify(diagnostics));
    assert.ok(!diagnostics.some(d => d.code === 2307), JSON.stringify(diagnostics));
    assert.equal(readFileSync(join(root, 'user-file.txt'), 'utf8'), 'original');
    assert.ok(!existsSync(join(root, 'build-cache')));
    assert.ok(!existsSync(join(root, 'node_modules/.svelte2tsx-language-server-files')));
    assert.ok(!existsSync(join(root, 'node_modules/.vite-temp')));
    await backend.close(join(root, 'article.svx'));
  } finally {
    await backend.dispose();
    assert.deepEqual(snapshot(root), before);
    assert.equal(serviceHash(), originalService);
    rmSync(root, { recursive: true, force: true });
  }
});
