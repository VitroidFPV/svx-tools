import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { SvxLanguageBackend } from '../src/language-backend.ts';

test('configured virtual roots survive sequential opens, edits, close/synchronize/reopen and disposal', async () => {
  const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)), 'fixtures/alias');
  const backend = new SvxLanguageBackend(workspace);
  const source = '<script lang="ts">\nimport Admonition from "$components/Admonition.svelte";\nlet count = 1;\n</script>\n<Admonition type="other" />\n';
  const a = resolve(workspace, 'lifecycle-a.svx');
  const b = resolve(workspace, 'lifecycle-b.svx');
  async function error(filename: string) {
    const result = await backend.diagnose(source, filename);
    assert.ok(result.some(d => d.code === 2322 && source.slice(d.start, d.end) === 'type'), JSON.stringify(result));
    assert.ok(!result.some(d => d.code === 2307), JSON.stringify(result));
  }
  try {
    await error(a);
    await error(b);
    assert.ok(JSON.stringify(await backend.hover(source, b, { line: 4, character: 13 })).includes('tip'));
    assert.ok(!(await backend.diagnose(source.replace('type="other"', 'type="tip"'), a)).some(d => d.code === 2322));
    await error(b);
    await backend.close(a);
    await error(b);
    const closed = await backend.inspect() as { projects: { roots: string[] }[] };
    assert.equal(closed.projects.length, 1);
    assert.ok(!closed.projects[0]!.roots.includes(`${a}.svelte`));
    await error(a);
    for (let index = 0; index < 5; index++) {
      const path = resolve(workspace, `lifecycle-${index}.svx`);
      await error(path);
      await backend.close(path);
      await error(b);
    }
    const pending = backend.diagnose(source, resolve(workspace, 'pending.svx'));
    const close = backend.close(resolve(workspace, 'pending.svx'));
    assert.deepEqual(await pending, []);
    await close;
    await error(b);
    assert.equal((await backend.inspect() as typeof closed).projects.length, 1);
    const before = await backend.inspect() as { pid: number };
    await backend.dispose();
    assert.throws(() => process.kill(before.pid, 0));
    assert.deepEqual(await backend.inspect(), { projects: [] });
  } finally {
    await backend.dispose();
  }
});

test('a crashed worker restarts with live documents and can close and reopen', async () => {
  const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)), 'fixtures/alias');
  const backend = new SvxLanguageBackend(workspace);
  const source = '<script lang="ts">let count: number = "bad";</script>\n{count}';
  const a = resolve(workspace, 'crash-a.svx'), b = resolve(workspace, 'crash-b.svx');
  async function crash() {
    const { pid } = await backend.inspect() as { pid: number };
    process.kill(pid, 'SIGKILL');
    for (let attempt = 0; attempt < 100; attempt++) {
      try { process.kill(pid, 0); } catch { return pid; }
      await setTimeout(10);
    }
    throw new Error('Worker did not exit');
  }
  try {
    await backend.diagnose(source, a);
    await backend.diagnose(source, b);
    const pid = await crash();
    assert.ok((await backend.diagnose(source, a)).some(d => d.code === 2322));
    assert.ok((await backend.diagnose(source, b)).some(d => d.code === 2322));
    const state = await backend.inspect() as { pid: number; projects: { roots: string[] }[] };
    assert.notEqual(state.pid, pid);
    assert.ok(state.projects[0]!.roots.includes(`${a}.svelte`));
    assert.ok(state.projects[0]!.roots.includes(`${b}.svelte`));
    await crash();
    await backend.close(a);
    await backend.close(b);
    assert.ok((await backend.diagnose(source, a)).some(d => d.code === 2322));
  } finally {
    await backend.dispose();
  }
});
