import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'bun:test';
import { mapGeneratedRange } from '../src/mappings.ts';
import { transformSvx } from '../src/transform.ts';

const fixture = new URL('../fixtures/basic.svx', import.meta.url).pathname;

test('maps unchanged script and raw markup, but not generated Markdown', async () => {
  const source = await readFile(fixture, 'utf8');
  const result = await transformSvx(source, fixture);

  for (const text of ['count = $state(0)', '<button onclick={() => count++}>']) {
    const start = result.code.indexOf(text);
    const mapped = mapGeneratedRange(result.mappings, start, start + text.length);
    assert.deepEqual(mapped, {
      start: source.indexOf(text),
      end: source.indexOf(text) + text.length
    });
  }

  const heading = result.code.indexOf('<h1>SVX prototype</h1>');
  assert.equal(mapGeneratedRange(result.mappings, heading, heading + 4), null);
});

test('does not map generated frontmatter or code inside Markdown fences', async () => {
  const source = '---\ntitle: Example\n---\n\n```\n<button>example</button>\n```\n\n<button>live</button>\n';
  const result = await transformSvx(source, '/tmp/regions.svx');

  assert.deepEqual(
    result.mappings.map(({ sourceStart, sourceEnd }) => source.slice(sourceStart, sourceEnd)),
    ['<button>live</button>']
  );
  assert.equal(mapGeneratedRange(result.mappings, 0, 1), null);
});

test('leaves repeated markup unmapped when its origin is ambiguous', async () => {
  const source = '<button>same</button>\n\n<button>same</button>\n';
  const result = await transformSvx(source, '/tmp/repeated.svx');
  assert.deepEqual(result.mappings, []);
});

test('maps standalone Svelte block directives', async () => {
  const source = '<script>let shown = $state(true)</script>\n\n{#if shown}\n<button>OK</button>\n{/if}\n';
  const result = await transformSvx(source, '/tmp/block.svx');

  for (const text of ['{#if shown}', '{/if}']) {
    const start = result.code.indexOf(text);
    assert.deepEqual(mapGeneratedRange(result.mappings, start, start + text.length), {
      start: source.indexOf(text),
      end: source.indexOf(text) + text.length
    });
  }
});
