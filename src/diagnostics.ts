import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SvelteCheck } from 'svelte-language-server';
import { createExactMappings, mapGeneratedRange } from './mappings.ts';
import { transformSvx } from './transform.ts';

export interface SvxDiagnostic {
  start: number;
  end: number;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
}

const require = createRequire(import.meta.url);
const temporaryConfigs = new Set<string>();
process.once('exit', () => {
  for (const directory of temporaryConfigs) rmSync(directory, { recursive: true, force: true });
});

function projectConfig(filename: string, workspacePath: string): string | undefined {
  let directory = dirname(filename);
  const boundary = resolve(workspacePath);
  while (directory.startsWith(`${boundary}/`) || directory === boundary) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    if (directory === boundary) break;
    directory = dirname(directory);
  }
}

function createChecker(filename: string, workspacePath: string) {
  // A virtual .svelte file is absent from tsconfig's file list, so give it a
  // temporary config that retains the project's aliases and ambient types.
  const directory = mkdtempSync(join(tmpdir(), 'svx-tools-'));
  temporaryConfigs.add(directory);
  const sveltePackage = require.resolve('svelte/package.json', { paths: [dirname(filename), workspacePath] });
  symlinkSync(dirname(dirname(sveltePackage)), join(directory, 'node_modules'), 'dir');
  const configPath = join(directory, 'tsconfig.json');
  const config = projectConfig(filename, workspacePath);
  const virtualPath = `${resolve(filename)}.svelte`;
  writeFileSync(configPath, JSON.stringify({
    ...(config ? { extends: config } : {
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true }
    }),
    files: [virtualPath, require.resolve('svelte2tsx/svelte-shims-v4.d.ts')]
  }));
  return {
    checker: new SvelteCheck(workspacePath, {
      diagnosticSources: ['js', 'svelte'],
      tsconfig: configPath,
      watch: false
    }),
    directory,
    opened: false
  };
}

function offsetAt(text: string, line: number, character: number): number | null {
  if (line < 0 || character < 0) return null;
  let start = 0;
  for (let current = 0; current < line; current++) {
    const next = text.indexOf('\n', start);
    if (next < 0) return null;
    start = next + 1;
  }
  const lineEnd = text.indexOf('\n', start);
  const end = lineEnd < 0 ? text.length : lineEnd;
  return start + character <= end ? start + character : null;
}

export class SvxDiagnostics {
  private readonly checkers = new Map<string, ReturnType<typeof createChecker>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly workspacePath: string) {}

  diagnose(source: string, filename: string): Promise<SvxDiagnostic[]> {
    const result = this.queue.then(() => this.run(source, filename));
    this.queue = result.catch(() => undefined);
    return result;
  }

  close(filename: string): void {
    const path = resolve(filename);
    this.queue = this.queue.then(async () => {
      const entry = this.checkers.get(path);
      if (!entry) return;
      await entry.checker.removeDocument(pathToFileURL(`${path}.svelte`).toString());
      this.checkers.delete(path);
      temporaryConfigs.delete(entry.directory);
      rmSync(entry.directory, { recursive: true, force: true });
    }).catch(() => undefined);
  }

  private async run(source: string, filename: string): Promise<SvxDiagnostic[]> {
    const transformed = await transformSvx(source, filename);
    // JavaScript files are not type checked by default. This enables checking
    // for SVX documents without a script, solely in the virtual document.
    const code = /<script\b/i.test(transformed.code)
      ? transformed.code
      : `<script>// @ts-check\n</script>\n${transformed.code}`;
    const mappings = createExactMappings(source, code);
    const path = resolve(filename);
    let entry = this.checkers.get(path);
    if (!entry) {
      entry = createChecker(filename, this.workspacePath);
      this.checkers.set(path, entry);
    }
    const virtualPath = `${path}.svelte`;
    const uri = pathToFileURL(virtualPath).toString();
    await entry.checker.upsertDocument(
      { uri, text: code },
      !entry.opened
    );
    entry.opened = true;

    const result = (await entry.checker.getDiagnostics()).find(
      (entry) => resolve(entry.filePath) === virtualPath
    );
    const mapped: SvxDiagnostic[] = [];
    for (const diagnostic of result?.diagnostics ?? []) {
      const start = offsetAt(code, diagnostic.range.start.line, diagnostic.range.start.character);
      const end = offsetAt(code, diagnostic.range.end.line, diagnostic.range.end.character);
      if (start === null || end === null) continue;
      const range = mapGeneratedRange(mappings, start, end);
      if (!range) continue;
      mapped.push({
        ...range,
        message: diagnostic.message,
        severity: diagnostic.severity,
        source: diagnostic.source,
        code: typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number'
          ? diagnostic.code
          : undefined
      });
    }
    return mapped;
  }
}
