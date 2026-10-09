import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SvxLanguageBackend } from '../src/language-backend.ts';

test('shares configured types across operations, isolates nested configs, and invalidates imports and configs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'svx-project-test-'));
  function write(path: string, text: string) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const config = (target: string) => JSON.stringify({
    compilerOptions: { strict: true, rootDirs: ['src', '.svelte-kit/types/src'], paths: { '$model': [target] } },
    include: ['src/**/*', '.svelte-kit/types/**/*', 'globals.ts']
  });
  write('tsconfig.json', config('./src/model.ts'));
  write('src/model.ts', 'export const value = 42; export interface Model { label: string }');
  write('src/other.ts', 'export const value = "text"; export interface Model { label: string }');
  write('src/relative.ts', 'export const relative = 1;');
  write('globals.ts', 'export {}; declare global { const ambientNumber: number }');
  write('.svelte-kit/types/src/routes/$types.d.ts', 'export interface PageData { title: string }');
  write('nested/jsconfig.json', JSON.stringify({ compilerOptions: { strict: true, paths: { '$model': ['./model.ts'] } }, include: ['**/*'] }));
  write('nested/model.ts', 'export const value = "nested"; export interface Model { label: string }');
  symlinkSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'node_modules'), join(root, 'node_modules'), 'dir');
  const backend = new SvxLanguageBackend(root);
  const filename = join(root, 'src/routes/article.svx');
  const source = '<script lang="ts">\nimport { value, type Model } from "$model";\nimport { relative } from "../relative";\nimport type { PageData } from "./$types";\nlet wrong: string = value;\nlet model: Model = { label: "hi" };\nlet data: PageData = { title: "page" };\nlet global: number = ambientNumber + relative;\nlet derived = value;\n</script>\n{model.label}\n';
  const document = TextDocument.create(pathToFileURL(filename).href, 'svx', 1, source);
  try {
    const diagnostics = await backend.diagnose(source, filename);
    assert.deepEqual(diagnostics.filter(d => d.severity === 1).map(d => [d.code, source.slice(d.start, d.end)]), [[2322, 'wrong']]);
    const hover = await backend.hover(source, filename, document.positionAt(source.indexOf('value', source.indexOf('let wrong'))));
    assert.ok(JSON.stringify(hover).includes('42'), JSON.stringify(hover));
    const completeSource = source.replace('{model.label}', '{model.la}');
    const completions = await backend.complete(completeSource, filename, { line: 10, character: 9 });
    assert.ok(completions.items.some(item => item.label === 'label'), JSON.stringify(completions));
    const hints = await backend.inlayHints(source, filename, { start: document.positionAt(0), end: document.positionAt(source.length) });
    assert.ok(hints.some(hint => hint.position.line === 8 && JSON.stringify(hint.label).includes('number')), JSON.stringify(hints));
    const localDefinitions = await backend.definition(source, filename, { line: 10, character: 3 }, false);
    assert.ok(localDefinitions.some(location => 'uri' in location && location.uri === document.uri && location.range.start.line === 5), JSON.stringify(localDefinitions));
    const nested = join(root, 'nested/article.svx');
    const nestedSource = '<script lang="ts">import { value } from "$model"; let text: string = value; let broken: number = "bad";</script>\n{text}';
    const nestedErrors = await backend.diagnose(nestedSource, nested);
    assert.deepEqual(nestedErrors.filter(d => d.severity === 1).map(d => [d.code, nestedSource.slice(d.start, d.end)]), [[2322, 'broken']]);
    assert.equal((await backend.inspect() as { projects: unknown[] }).projects.length, 2);
    await backend.close(nested);
    assert.equal((await backend.inspect() as { projects: unknown[] }).projects.length, 1);
    write('src/model.ts', 'export const value = "changed"; export interface Model { label: string }');
    assert.ok(!(await backend.diagnose(source, filename)).some(d => d.code === 2322));
    write('src/model.ts', 'export const value = 42; export interface Model { label: string }');
    assert.ok((await backend.diagnose(source, filename)).some(d => d.code === 2322));
    write('tsconfig.json', config('./src/other.ts'));
    // Upstream config watchers poll every second. Wait for their invalidation.
    await setTimeout(1300);
    assert.ok(!(await backend.diagnose(source, filename)).some(d => d.code === 2322));
    assert.equal((await backend.inspect() as { projects: unknown[] }).projects.length, 1);
    write('src/routes/tsconfig.json', JSON.stringify({ extends: '../../tsconfig.json', compilerOptions: { paths: { '$model': ['../model.ts'] } } }));
    assert.ok((await backend.diagnose(source, filename)).some(d => d.code === 2322));
    assert.equal((await backend.inspect() as { projects: unknown[] }).projects.length, 1);
    rmSync(join(root, 'src/routes/tsconfig.json'));
    assert.ok(!(await backend.diagnose(source, filename)).some(d => d.code === 2322));
    assert.equal((await backend.inspect() as { projects: unknown[] }).projects.length, 1);
  } finally {
    await backend.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded inferred project supports no-script checking, incomplete completion and a fresh generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'svx-inferred-test-'));
  symlinkSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'node_modules'), join(root, 'node_modules'), 'dir');
  const backend = new SvxLanguageBackend(root);
  const a = join(root, 'a.svx'), b = join(root, 'b.svx');
  try {
    const source = '# Title\n\n{missingValue}\n';
    const errors = await backend.diagnose(source, a);
    assert.ok(errors.some(d => d.code === 2304 && source.slice(d.start, d.end) === 'missingValue'));
    await backend.diagnose(source, b);
    const incomplete = '<script lang="ts">\nlet count = 1;\ncou\n</script>\n';
    const completions = await backend.complete(incomplete, a, { line: 2, character: 3 });
    assert.ok(completions.items.some(item => item.label === 'count'));
    const pending = backend.diagnose(source, a);
    await setTimeout(1);
    const close = backend.close(a);
    await pending;
    await close;
    await backend.diagnose(source, b);
    const state = await backend.inspect() as { projects: { roots: string[] }[] };
    assert.equal(state.projects.length, 1);
    assert.ok(!state.projects[0]!.roots.includes(`${a}.svelte`));
    assert.ok((await backend.diagnose(source, a)).some(d => d.code === 2304));
    const superseded = Array.from({ length: 20 }, (_, index) => backend.diagnose(`{missing${index}}`, a));
    const results = await Promise.all(superseded);
    assert.ok(results.slice(0, -1).every(result => result.length === 0));
    assert.ok(results.at(-1)!.some(d => d.message.includes('missing19')));
    const worker = await backend.inspect() as { pid: number };
    await backend.close(a);
    await backend.close(b);
    assert.throws(() => process.kill(worker.pid, 0));
    assert.ok((await backend.diagnose(source, a)).some(d => d.code === 2304));
  } finally {
    await backend.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('newly created imports replace failed resolutions without restarting the project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'svx-new-import-test-'));
  symlinkSync(resolve(fileURLToPath(new URL('..', import.meta.url)), 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    strict: true, paths: { '$new': ['./New.svelte'] }
  }, include: ['**/*'] }));
  const backend = new SvxLanguageBackend(root);
  const filename = join(root, 'article.svx');
  const source = '<script lang="ts">import { value } from "./created/model"; import New from "$new"; let wrong: string = value;</script>\n{value}\n<New answer={value} />';
  try {
    assert.ok((await backend.diagnose(source, filename)).some(d => d.code === 2307));
    const before = await backend.inspect() as { pid: number };
    mkdirSync(join(root, 'created'));
    assert.ok((await backend.diagnose(source, filename)).some(d => d.code === 2307));
    writeFileSync(join(root, 'created/model.ts'), 'export const value = 42;');
    writeFileSync(join(root, 'New.svelte'), '<script lang="ts">export let answer: number;</script>{answer}');
    const errors = await backend.diagnose(source, filename);
    assert.ok(!errors.some(d => d.code === 2307), JSON.stringify(errors));
    assert.ok(errors.some(d => d.code === 2322), JSON.stringify(errors));
    const position = { line: 0, character: source.indexOf('value') + 2 };
    const hover = await backend.hover(source, filename, position);
    assert.ok(JSON.stringify(hover).includes('42'), JSON.stringify(hover));
    assert.ok(!(await backend.diagnose(source + '\nEdited', filename)).some(d => d.code === 2307));
    rmSync(join(root, 'created/model.ts'));
    assert.ok((await backend.diagnose(source, filename)).some(d => d.code === 2307));
    writeFileSync(join(root, 'created/model.ts'), 'export const value = 99;');
    assert.ok(!(await backend.diagnose(source, filename)).some(d => d.code === 2307));
    const recreatedHover = await backend.hover(source, filename, position);
    assert.ok(JSON.stringify(recreatedHover).includes('99'), JSON.stringify(recreatedHover));
    assert.equal((await backend.inspect() as { pid: number }).pid, before.pid);
  } finally {
    await backend.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
