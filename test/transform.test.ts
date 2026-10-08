import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'bun:test';
import { transformSvx } from '../src/transform.ts';

const filename = new URL('../fixtures/basic.svx', import.meta.url).pathname;

test('MDsveX output containing Svelte 5 syntax parses as Svelte', async () => {
  const source = await readFile(filename, 'utf8');
  const result = await transformSvx(source, filename);

  assert.match(result.code, /<h1>SVX prototype<\/h1>/);
  assert.match(result.code, /\$state\(0\)/);
  assert.match(result.code, /onclick=\{\(\) => count\+\+\}/);
});
