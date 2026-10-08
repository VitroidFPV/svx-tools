import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';
import { SvxDiagnostics } from '../src/diagnostics.ts';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const filename = resolve(workspace, 'fixtures/error.svx');

test('reports an undefined Svelte handler at its original SVX range', async () => {
  const source = '# Introduction\n\n<button onclick={missingHandler}>Click</button>\n';
  const checker = new SvxDiagnostics(workspace);
  const result = await checker.diagnose(source, filename);
  const missing = result.find((item) => item.code === 2304);

  assert.ok(missing, JSON.stringify(result));
  assert.equal(source.slice(missing.start, missing.end), 'missingHandler');
  assert.equal(source.slice(0, missing.start).split('\n').length, 3);

  const fixed = await checker.diagnose(
    '# Introduction\n\n<button onclick={() => {}}>Click</button>\n',
    filename
  );
  assert.equal(fixed.some((item) => item.code === 2304), false);
});
