import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';
import { SvxDiagnostics } from '../src/diagnostics.ts';

const workspace = fileURLToPath(new URL('..', import.meta.url));
const filename = resolve(workspace, 'fixtures/error.svx');

test('maps the error fixture diagnostics to their original lines', async () => {
  const source = readFileSync(filename, 'utf8');
  const checker = new SvxDiagnostics(workspace);
  const result = await checker.diagnose(source, filename);

  assert.deepEqual(
    result.map((item) => ({
      code: item.code,
      text: source.slice(item.start, item.end),
      line: source.slice(0, item.start).split('\n').length
    })).sort((a, b) => a.line - b.line),
    [
      { code: 2322, text: 'count', line: 2 },
      { code: 2304, text: 'missingHandler', line: 7 },
      { code: 2304, text: 'missingValue', line: 8 },
      { code: 2304, text: 'missingStandalone', line: 9 },
      { code: 'a11y_missing_attribute', text: '<img src="example.png">', line: 10 }
    ]
  );
});

test('reports an undefined Svelte handler at its original SVX range', async () => {
  const source = '# Introduction\n\n<button onclick={missingHandler}>Click</button>\n';
  const checker = new SvxDiagnostics(workspace);
  const syntheticFilename = resolve(workspace, 'fixtures/error-no-script.svx');
  const result = await checker.diagnose(source, syntheticFilename);
  const missing = result.find((item) => item.code === 2304);

  assert.ok(missing, JSON.stringify(result));
  assert.equal(source.slice(missing.start, missing.end), 'missingHandler');
  assert.equal(source.slice(0, missing.start).split('\n').length, 3);

  const fixed = await checker.diagnose(
    '# Introduction\n\n<button onclick={() => {}}>Click</button>\n',
    syntheticFilename
  );
  assert.equal(fixed.some((item) => item.code === 2304), false);
});

test('formatting fixture has no TypeScript assignment error', async () => {
  const fixture = resolve(workspace, 'fixtures/formatting.svx');
  const source = readFileSync(fixture, 'utf8');
  const checker = new SvxDiagnostics(workspace);
  const result = await checker.diagnose(source, fixture);
  assert.equal(result.some((diagnostic) => diagnostic.code === 2588), false);
});
