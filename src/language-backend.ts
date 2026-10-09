import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  CompletionItem, CompletionList, Hover, InlayHint, Location, LocationLink,
  Position, Range, TextEdit
} from 'vscode-languageserver/node';
import { createExactMappings, mapGeneratedRange, mapSourceRange, type ExactMapping } from './mappings.ts';
import { transformSvx } from './transform.ts';

interface VirtualDocument {
  uri: string;
  document: TextDocument;
  mappings: ExactMapping[];
  source: TextDocument;
}

function mapRange(range: Range, virtual: VirtualDocument): Range | null {
  const start = virtual.document.offsetAt(range.start);
  const end = virtual.document.offsetAt(range.end);
  const mapped = mapGeneratedRange(virtual.mappings, start, end);
  return mapped && {
    start: virtual.source.positionAt(mapped.start),
    end: virtual.source.positionAt(mapped.end)
  };
}

function mapPosition(position: Position, virtual: VirtualDocument): Position | null {
  const offset = virtual.document.offsetAt(position);
  const mapped = mapGeneratedRange(virtual.mappings, offset, offset);
  return mapped ? virtual.source.positionAt(mapped.start) : null;
}

function mapLocation(location: Location, virtual: VirtualDocument): Location | null {
  if (location.uri !== virtual.uri) return location;
  const range = mapRange(location.range, virtual);
  return range && { uri: virtual.source.uri, range };
}

function importedPathAt(source: string, offset: number): { specifier: string; start: number; end: number } | null {
  for (const script of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const content = script[1]!;
    const start = script.index + script[0].indexOf('>') + 1;
    if (offset < start || offset > start + content.length) continue;
    const file = ts.createSourceFile('article.ts', content, ts.ScriptTarget.Latest, true);
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)
        && start + specifier.getStart(file) <= offset
        && offset < start + specifier.getEnd()) return {
          specifier: specifier.text,
          start: start + specifier.getStart(file) + 1,
          end: start + specifier.getEnd() - 1
        };
    }
  }
  return null;
}

function importedFile(specifier: string, filename: string): string | null {
  const configPath = ts.findConfigFile(dirname(filename), ts.sys.fileExists, 'tsconfig.json')
    ?? ts.findConfigFile(dirname(filename), ts.sys.fileExists, 'jsconfig.json');
  let options: ts.CompilerOptions = {};
  if (configPath) {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!config.error) {
      options = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath)).options;
    }
  }
  const resolved = ts.resolveModuleName(specifier, filename, options, ts.sys).resolvedModule?.resolvedFileName;
  if (resolved && existsSync(resolved)) return resolved;

  const candidates: string[] = [];
  if (specifier.startsWith('.')) candidates.push(resolve(dirname(filename), specifier));
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    const wildcard = pattern.indexOf('*');
    const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
    const suffix = wildcard < 0 ? '' : pattern.slice(wildcard + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    if (wildcard < 0 && specifier !== pattern) continue;
    const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
    const base = (options as ts.CompilerOptions & { pathsBasePath?: string }).pathsBasePath
      ?? options.baseUrl ?? dirname(configPath ?? filename);
    for (const target of targets) {
      const path = wildcard < 0 ? target : target.replace('*', middle);
      candidates.push(resolve(base, path));
    }
  }
  try { candidates.push(createRequire(filename).resolve(specifier)); } catch { /* No package match. */ }
  return candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate)) ?? null;
}

function mapEdit(edit: TextEdit, virtual: VirtualDocument): TextEdit | null {
  const range = mapRange(edit.range, virtual);
  return range && { range, newText: edit.newText };
}

function mapItem(item: CompletionItem, virtual: VirtualDocument): CompletionItem | null {
  const mapped = { ...item };
  if (item.textEdit) {
    if ('range' in item.textEdit) {
      const edit = mapEdit(item.textEdit, virtual);
      if (!edit) return null;
      mapped.textEdit = edit;
    } else {
      const insert = mapRange(item.textEdit.insert, virtual);
      const replace = mapRange(item.textEdit.replace, virtual);
      if (!insert || !replace) return null;
      mapped.textEdit = { ...item.textEdit, insert, replace };
    }
  }
  if (item.additionalTextEdits) {
    const edits = item.additionalTextEdits.map((edit) => mapEdit(edit, virtual));
    if (edits.some((edit) => !edit)) return null;
    mapped.additionalTextEdits = edits as TextEdit[];
  }
  // Completion resolution belongs to the virtual Svelte server.
  delete mapped.data;
  return mapped;
}

export interface SvxDiagnostic {
  start: number;
  end: number;
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
}

interface DocumentState {
  source: string;
  revision: number;
  virtual?: VirtualDocument;
  connection?: MessageConnection;
}

export class SvxLanguageBackend {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private ready?: Promise<MessageConnection>;
  private readonly documents = new Map<string, DocumentState>();
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly onExit = () => this.process?.kill();

  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) { this.workspaceRoot = workspaceRoot; }

  private start(): Promise<MessageConnection> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const directory = typeof __dirname === 'string' ? __dirname : dirname(fileURLToPath(import.meta.url));
      const worker = resolve(directory, 'svelte-worker.cjs');
      const child = spawn(process.execPath, [...(globalThis.gc ? ['--expose-gc'] : []), worker], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      this.process = child;
      process.once('exit', this.onExit);
      child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
      const stopped = new Promise<never>((_, reject) => {
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`Svelte backend exited with code ${code}`)));
      });
      const connection = createMessageConnection(child.stdout, child.stdin);
      this.connection = connection;
      const reset = () => {
        connection.dispose();
        if (this.process !== child) return;
        this.process = undefined;
        this.connection = undefined;
        this.ready = undefined;
        process.removeListener('exit', this.onExit);
        for (const state of this.documents.values()) state.connection = undefined;
      };
      child.once('exit', reset);
      child.once('error', reset);
      connection.listen();
      try {
        await Promise.race([connection.sendRequest('initialize', { workspaceRoot: this.workspaceRoot }), stopped]);
      } catch (error) {
        child.kill();
        reset();
        throw error;
      }
      return connection;
    })();
    return this.ready;
  }

  private request<T>(method: string, params: { textDocument: { uri: string }; position?: Position; range?: Range }): Promise<T> {
    return this.connection!.sendRequest<T>('operation', {
      uri: params.textDocument.uri, method: method.slice('textDocument/'.length),
      position: params.position, range: params.range
    });
  }

  diagnose(source: string, filename: string): Promise<SvxDiagnostic[]> {
    return this.withDocument(source, filename, [], async virtual => {
      const diagnostics = await this.request<import('vscode-languageserver/node').Diagnostic[]>('textDocument/diagnostics', {
        textDocument: { uri: virtual.uri }
      });
      return diagnostics.flatMap(diagnostic => {
        const range = mapGeneratedRange(virtual.mappings,
          virtual.document.offsetAt(diagnostic.range.start), virtual.document.offsetAt(diagnostic.range.end));
        return range ? [{ ...range, message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value, severity: diagnostic.severity,
          source: diagnostic.source, code: typeof diagnostic.code === 'number' || typeof diagnostic.code === 'string'
            ? diagnostic.code : undefined }] : [];
      });
    });
  }

  complete(source: string, filename: string, position: Position): Promise<CompletionList> {
    return this.withDocument(source, filename, { isIncomplete: false, items: [] }, virtual => this.runCompletion(virtual, position));
  }

  hover(source: string, filename: string, position: Position): Promise<Hover | null> {
    return this.withDocument(source, filename, null, async virtual => {
      const offset = virtual.source.offsetAt(position);
      const mapped = mapSourceRange(virtual.mappings, offset, offset);
      if (!mapped) return null;
      const hover = await this.request<Hover | null>('textDocument/hover', {
        textDocument: { uri: virtual.uri }, position: virtual.document.positionAt(mapped.start)
      });
      if (!hover) return null;
      const range = hover.range && mapRange(hover.range, virtual);
      return { contents: hover.contents, ...(range ? { range } : {}) };
    });
  }

  definition(source: string, filename: string, position: Position, linkSupport = true): Promise<Location[] | LocationLink[]> {
    return this.withDocument<Location[] | LocationLink[]>(source, filename, [], async virtual => {
      const offset = virtual.source.offsetAt(position);
      const mapped = mapSourceRange(virtual.mappings, offset, offset);
      if (!mapped) return [];
      const importedPath = importedPathAt(virtual.source.getText(), offset);
      const response = await this.request<Location | Location[] | LocationLink[] | null>(
        'textDocument/definition',
        { textDocument: { uri: virtual.uri }, position: virtual.document.positionAt(mapped.start) }
      );
      let locations: Location[];
      if (!response || (Array.isArray(response) && response.length === 0)) {
        const path = importedPath && importedFile(importedPath.specifier, filename);
        locations = path ? [{ uri: pathToFileURL(path).toString(), range: {
          start: { line: 0, character: 0 }, end: { line: 0, character: 0 }
        } }] : [];
      } else {
        const targets = Array.isArray(response) ? response : [response];
        locations = targets.map((location) => {
          if ('targetUri' in location) {
            return mapLocation({ uri: location.targetUri, range: location.targetSelectionRange }, virtual);
          }
          return mapLocation(location, virtual);
        }).filter((location): location is Location => location !== null);
      }
      if (!linkSupport) return locations;
      const originSelectionRange = importedPath && {
        start: virtual.source.positionAt(importedPath.start),
        end: virtual.source.positionAt(importedPath.end)
      };
      return locations.map((location): LocationLink => ({
        targetUri: location.uri,
        targetRange: location.range,
        targetSelectionRange: location.range,
        ...(originSelectionRange ? { originSelectionRange } : {})
      }));
    });
  }

  inlayHints(source: string, filename: string, range: Range): Promise<InlayHint[]> {
    return this.withDocument(source, filename, [], async virtual => {
      const start = virtual.source.offsetAt(range.start);
      const end = virtual.source.offsetAt(range.end);
      const covered = virtual.mappings.filter((mapping) => mapping.sourceEnd >= start && mapping.sourceStart <= end);
      if (!covered.length) return [];
      const first = covered[0]!;
      const last = covered[covered.length - 1]!;
      const virtualRange = {
        start: virtual.document.positionAt(first.generatedStart + Math.max(0, start - first.sourceStart)),
        end: virtual.document.positionAt(last.generatedEnd - Math.max(0, last.sourceEnd - end))
      };
      const hints = await this.request<InlayHint[] | null>('textDocument/inlayHint', {
        textDocument: { uri: virtual.uri }, range: virtualRange
      });
      return (hints ?? []).flatMap((hint) => {
        const position = mapPosition(hint.position, virtual);
        if (!position) return [];
        const sourceOffset = virtual.source.offsetAt(position);
        if (sourceOffset < start || sourceOffset > end) return [];
        const label = typeof hint.label === 'string' ? hint.label : hint.label.map((part) => {
          if (!part.location) return part;
          const location = mapLocation(part.location, virtual);
          return { ...part, location: location ?? undefined };
        });
        return [{ label, position, kind: hint.kind, paddingLeft: hint.paddingLeft,
          paddingRight: hint.paddingRight, tooltip: hint.tooltip }];
      });
    });
  }

  private withDocument<T>(source: string, filename: string, empty: T, task: (virtual: VirtualDocument) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('SVX backend is disposed'));
    const path = resolve(filename);
    let state = this.documents.get(path);
    if (!state) {
      state = { source, revision: 0 };
      this.documents.set(path, state);
    } else if (state.source !== source) {
      state.source = source;
      state.revision++;
    }
    const current = state;
    const revision = state.revision;
    const valid = () => !this.disposed && this.documents.get(path) === current && current.revision === revision;
    return this.enqueue(async () => {
      if (!valid()) return empty;
      if (!current.virtual || current.virtual.source.getText() !== current.source) {
        const text = current.source;
        const transformed = await transformSvx(text, path, { validate: false });
        if (!valid()) return empty;
        const code = /<script\b/i.test(transformed.code) ? transformed.code
          : `<script>// @ts-check\n</script>\n${transformed.code}`;
        const uri = pathToFileURL(`${path}.svelte`).href;
        const virtual: VirtualDocument = {
          uri, source: TextDocument.create(pathToFileURL(path).href, 'svx', revision, text),
          document: TextDocument.create(uri, 'svelte', revision, code),
          mappings: code === transformed.code ? transformed.mappings : createExactMappings(text, code)
        };
        current.virtual = virtual;
        current.connection = undefined;
      }
      const connection = await this.start();
      if (!valid()) return empty;
      if (current.connection !== connection) {
        await connection.sendRequest('sync', { uri: current.virtual.uri, text: current.virtual.document.getText() });
        if (!valid()) return empty;
        current.connection = connection;
      }
      const result = await task(current.virtual);
      return valid() ? result : empty;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async runCompletion(virtual: VirtualDocument, position: Position): Promise<CompletionList> {
    const sourceOffset = virtual.source.offsetAt(position);
    const offset = mapSourceRange(virtual.mappings, sourceOffset, sourceOffset);
    if (!offset) return { isIncomplete: false, items: [] };
    const response = await this.request<CompletionList | CompletionItem[] | null>(
      'textDocument/completion',
      { textDocument: { uri: virtual.uri }, position: virtual.document.positionAt(offset.start) }
    );
    const list = Array.isArray(response) ? { isIncomplete: false, items: response }
      : response ?? { isIncomplete: false, items: [] };
    return { ...list, items: list.items.map((item) => mapItem(item, virtual)).filter((item): item is CompletionItem => !!item) };
  }

  close(filename: string): Promise<void> {
    const path = resolve(filename);
    this.documents.delete(path);
    return this.enqueue(async () => {
      await this.connection?.sendRequest('close', { uri: pathToFileURL(`${path}.svelte`).href });
      // Session-idle policy: release all upstream caches when no documents remain.
      if (!this.documents.size) await this.stop();
    });
  }

  inspect(): Promise<unknown> {
    return this.enqueue(async () => this.connection
      ? this.connection.sendRequest('inspect', { gc: !!globalThis.gc }) : { projects: [] });
  }

  private async stop(): Promise<void> {
    const child = this.process;
    const connection = this.connection;
    this.ready = undefined;
    this.process = undefined;
    this.connection = undefined;
    process.removeListener('exit', this.onExit);
    if (!child) return;
    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await connection?.sendRequest('shutdown'); } catch { child.kill(); }
    await exited;
    clearTimeout(timeout);
    connection?.dispose();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    this.documents.clear();
    return this.enqueue(() => this.stop());
  }
}
