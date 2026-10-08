import { resolve } from 'node:path';
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
  private readonly checker: SvelteCheck;
  private readonly opened = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(workspacePath: string) {
    this.checker = new SvelteCheck(workspacePath, {
      diagnosticSources: ['js', 'svelte'],
      watch: false
    });
  }

  diagnose(source: string, filename: string): Promise<SvxDiagnostic[]> {
    const result = this.queue.then(() => this.run(source, filename));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(source: string, filename: string): Promise<SvxDiagnostic[]> {
    const transformed = await transformSvx(source, filename);
    // JavaScript files are not type checked by default. This enables checking
    // for SVX documents without a script, solely in the virtual document.
    const code = /<script\b/i.test(transformed.code)
      ? transformed.code
      : `<script>// @ts-check\n</script>\n${transformed.code}`;
    const mappings = createExactMappings(source, code);
    const virtualPath = `${resolve(filename)}.svelte`;
    const uri = pathToFileURL(virtualPath).toString();
    await this.checker.upsertDocument(
      { uri, text: code },
      !this.opened.has(virtualPath)
    );
    this.opened.add(virtualPath);

    const result = (await this.checker.getDiagnostics()).find(
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
