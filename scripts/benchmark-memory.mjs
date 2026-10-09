import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Supply a bundled module exporting SvxLanguageBackend (or the baseline's two classes).
const [modulePath, workspacePath = 'fixtures/alias', countArg = '20', cyclesArg = '50'] = process.argv.slice(2);
const workspace = resolve(workspacePath);
const imported = await import(pathToFileURL(resolve(modulePath)).href);
const api = imported.default ?? imported;
const require = createRequire(resolve(modulePath));
function version(name, from = require) {
  let directory;
  try { directory = dirname(from.resolve(name)); } catch { return null; }
  while (directory !== dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
      if (pkg.name === name) return pkg.version;
    } catch { /* The entry may be below the package root. */ }
    directory = dirname(directory);
  }
}
const backend = api.SvxLanguageBackend ? new api.SvxLanguageBackend(workspace) : null;
const diagnostics = backend ?? new api.SvxDiagnostics(workspace);
const features = backend ?? new api.SvxLanguageFeatures(workspace);
const alias = workspace.endsWith('/fixtures/alias');
const articles = alias ? [] : readdirSync(resolve(workspace, 'src/content/home')).filter(name => name.endsWith('.svx'));
const sourceAt = index => alias
  ? '<script lang="ts">\nimport Admonition from "$components/Admonition.svelte";\nlet count = 1;\n</script>\n<Admonition type="other" />\n'
  : readFileSync(resolve(workspace, 'src/content/home', articles[index % articles.length]), 'utf8') + '\n{svxMemoryProbeMissing}\n';
const filenameAt = index => resolve(workspace, alias ? '' : 'src/content/home', `memory-${index}.svx`);
const openingSamples = [];
async function sample(label, latency = {}) {
  const backendState = backend?.inspect ? await backend.inspect() : undefined;
  globalThis.gc?.();
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  assert.equal(ps.status, 0, ps.stderr);
  const rows = ps.stdout.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const pids = new Set([process.pid]);
  for (let previous = 0; previous !== pids.size;) {
    previous = pids.size;
    for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid);
  }
  const rss = rows.filter(([pid]) => pids.has(pid) && pid !== ps.pid).reduce((sum, [, , rss]) => sum + rss, 0) / 1024;
  if (label.startsWith('open-')) openingSamples.push(rss);
  if (backend && alias) assert.equal(backendState.projects.length, 1);
  console.log(JSON.stringify({ label, combinedRssMiB: rss, parent: process.memoryUsage(), parentPeakRssMiB: process.resourceUsage().maxRSS / 1024,
    backend: backendState, childCount: Math.max(0, pids.size - 2), forcedGC: !!globalThis.gc, ...latency }));
}
async function check(index) {
  const source = sourceAt(index), filename = filenameAt(index);
  const start = performance.now();
  const result = await diagnostics.diagnose(source, filename);
  const diagnosticMs = performance.now() - start;
  assert.ok(result.some(d => alias ? d.code === 2322 && source.slice(d.start, d.end) === 'type' : d.code === 2304 && d.message.includes('svxMemoryProbeMissing')), JSON.stringify(result));
  if (alias) assert.ok(!result.some(d => d.code === 2307), JSON.stringify(result));
  const featureStart = performance.now();
  if (alias) assert.ok(JSON.stringify(await features.hover(source, filename, { line: 2, character: 5 })).includes('number'));
  else {
    const prefix = source.slice(0, source.lastIndexOf('svxMemoryProbeMissing'));
    const lines = prefix.split('\n');
    await features.hover(source, filename, { line: lines.length - 1, character: lines.at(-1).length + 2 });
  }
  return { diagnosticMs, featureMs: performance.now() - featureStart };
}
console.log(JSON.stringify({ node: process.version, flags: process.execArgv,
  dependencies: Object.fromEntries(['svelte-language-server', 'svelte', 'typescript', 'svelte2tsx', 'mdsvex'].map(name => [name, version(name)])),
  workspaceDependencies: Object.fromEntries(['svelte', 'typescript'].map(name => [name, version(name, createRequire(resolve(workspace, 'package.json')))])),
  workspace, modulePath, documents: Number(countArg), cycles: Number(cyclesArg) }));
try {
  for (let index = 0; index < Number(countArg); index++) {
    const latency = await check(index);
    if ([0, 3, 19].includes(index) || index === Number(countArg) - 1) await sample(`open-${index + 1}`, latency);
  }
  await sample('warm', await check(0));
  for (let index = 0; index < Number(cyclesArg); index++) {
    const id = Number(countArg) + index;
    await check(id);
    diagnostics.close(filenameAt(id));
    if (!backend) features.close(filenameAt(id));
    await check(0);
    if ((index + 1) % 10 === 0) await sample(`cycle-${index + 1}`, await check(0));
  }
  diagnostics.close(filenameAt(0));
  if (!backend) features.close(filenameAt(0));
  if (Number(countArg) > 1) await check(1);
  await sample('reopen', await check(0));
  if (backend?.inspect) console.log(JSON.stringify(await backend.inspect()));
  if (backend && alias && globalThis.gc && Number(countArg) >= 20) {
    assert.ok(openingSamples.at(-1) - openingSamples[0] < 150, 'First-to-twentieth document RSS growth must stay below 150 MiB');
  }
} finally {
  if (backend) await backend.dispose();
  else { features.dispose(); }
}
