import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entryArg = 'dist/lsp.cjs', workspaceArg = '/tmp/svx-lsp-smoke'] = process.argv.slice(2);
const entry = resolve(entryArg), workspace = resolve(workspaceArg);
const require = createRequire(entry);
const { createMessageConnection } = require('vscode-jsonrpc/node.js');
mkdirSync(resolve(workspace, 'components'), { recursive: true });
writeFileSync(resolve(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
  strict: true, paths: { '$components/*': ['./components/*'] }
}, include: ['**/*.svelte'] }));
writeFileSync(resolve(workspace, 'components/Panel.svelte'), '<script lang="ts">let { kind }: { kind: "tip" | "warning" } = $props();</script>\n<aside>{kind}</aside>');
writeFileSync(resolve(workspace, 'components/value.ts'), 'export const value = 42;');
const source = '<script lang="ts">\nimport Panel from "$components/Panel.svelte";\nimport { value } from "$components/value"; let count = value;\n</script>\n<Panel kind="other" />\n';
const uri = pathToFileURL(resolve(workspace, 'article.svx')).href;
const other = pathToFileURL(resolve(workspace, 'other.svx')).href;
const child = spawn(process.execPath, [entry, '--stdio'], { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', data => { stderr += data; });
const connection = createMessageConnection(child.stdout, child.stdin);
child.once('exit', () => connection.dispose());
const messages = [];
const logs = [];
connection.onNotification('textDocument/publishDiagnostics', params => messages.push(params));
connection.onNotification('window/logMessage', params => logs.push(params));
connection.listen();
const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
async function diagnostics(documentUri, version, code) {
  for (let index = 0; index < 150; index++) {
    const result = messages.findLast(params => params.uri === documentUri && params.version === version);
    if (result && (code === null || result.diagnostics.some(d => d.code === code))) return result.diagnostics;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Missing diagnostics for ${documentUri} v${version}: ${JSON.stringify({ messages, logs, stderr })}`);
}
function open(documentUri) {
  messages.splice(0);
  connection.sendNotification('textDocument/didOpen', { textDocument: { uri: documentUri, languageId: 'svx', version: 1, text: source } });
}
try {
  const initialized = await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).href,
    capabilities: { textDocument: { definition: { linkSupport: true } } } });
  assert.ok(initialized.capabilities.hoverProvider);
  connection.sendNotification('initialized', {});
  open(uri);
  const first = await diagnostics(uri, 1, 2322);
  assert.ok(first.some(d => d.code === 2322 && d.range.start.line === 4 && d.range.start.character === 7), JSON.stringify(first));
  assert.ok(!first.some(d => d.code === 2307));
  const hover = await connection.sendRequest('textDocument/hover', { textDocument: { uri }, position: { line: 2, character: 10 } });
  assert.ok(JSON.stringify(hover).includes('42'), JSON.stringify(hover));
  connection.sendNotification('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: source.replace('kind="other"', 'kind="tip"') }] });
  const fixed = await diagnostics(uri, 2, null);
  assert.ok(!fixed.some(d => d.code === 2322), JSON.stringify(fixed));
  open(other);
  await diagnostics(other, 1, 2322);
  connection.sendNotification('textDocument/didClose', { textDocument: { uri } });
  await connection.sendRequest('textDocument/hover', { textDocument: { uri: other }, position: { line: 2, character: 5 } });
  open(uri); // Reopening resets the editor version; the backend must use a new generation.
  await diagnostics(uri, 1, 2322);
  const descendants = await import('node:child_process').then(({ execFileSync }) => execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }))
    .then(output => output.trim().split('\n').map(row => row.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === child.pid).map(([pid]) => pid));
  assert.equal(descendants.length, 1, 'Exactly one shared worker');
  await connection.sendRequest('shutdown');
  connection.sendNotification('exit');
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  assert.equal(child.exitCode, 0, stderr);
  for (const pid of descendants) assert.throws(() => process.kill(pid, 0), 'Worker must exit');
  assert.ok(!logs.some(log => /Failed to/.test(log.message)), JSON.stringify(logs));
  console.log('PASS: stdio diagnostics, configured feature typing, edit, close/reopen, shutdown and worker exit');
} finally {
  clearTimeout(timeout);
  connection.dispose();
  if (child.exitCode === null) child.kill();
}
