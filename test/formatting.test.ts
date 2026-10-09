import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'bun:test';
import { formatSvx } from '../src/formatting.ts';

test('formats Markdown, fenced code and raw Svelte blocks', async () => {
  const filename = new URL('../fixtures/formatting.svx', import.meta.url).pathname;
  const source = await readFile(filename, 'utf8');
  const expected = await readFile(new URL('../fixtures/formatting.expected.svx', import.meta.url), 'utf8');
  const formatted = await formatSvx(source, filename, 2, true);
  assert.equal(formatted, expected);
  assert.equal(await formatSvx(formatted, filename, 2, true), expected);
});
