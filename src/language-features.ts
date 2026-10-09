import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type {
  CompletionItem, CompletionList, Hover, InlayHint, Location, LocationLink,
  Position, Range, TextEdit
} from 'vscode-languageserver/node';
import { mapGeneratedRange, mapSourceRange, type ExactMapping } from './mappings.ts';
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

export class SvxLanguageFeatures {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private ready?: Promise<MessageConnection>;
  private readonly versions = new Map<string, number>();
  private readonly virtuals = new Map<string, VirtualDocument>();
  private readonly workspaceRoot: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  private start(): Promise<MessageConnection> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const entry = process.argv[1] && !process.argv[1].startsWith('-') ? process.argv[1] : 'package.json';
      const requireFromEntry = createRequire(resolve(entry));
      const server = resolve(dirname(requireFromEntry.resolve('svelte-language-server/package.json')), 'bin/server.js');
      const child = spawn(process.execPath, [server, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.process = child;
      process.once('exit', () => child.kill());
      child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
      const stopped = new Promise<never>((_, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Svelte language server exited with code ${code}`)));
      });
      const connection = createMessageConnection(child.stdout, child.stdin);
      this.connection = connection;
      connection.onRequest('client/registerCapability', () => null);
      connection.onRequest('workspace/configuration', () => []);
      connection.listen();
      const rootUri = pathToFileURL(this.workspaceRoot).toString();
      await Promise.race([connection.sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'SVX' }],
        capabilities: { workspace: { configuration: true } },
        initializationOptions: { configuration: {
          typescript: { inlayHints: {
            variableTypes: { enabled: true },
            functionLikeReturnTypes: { enabled: true },
            parameterTypes: { enabled: true },
            propertyDeclarationTypes: { enabled: true }
          } },
          javascript: { inlayHints: {
            variableTypes: { enabled: true },
            functionLikeReturnTypes: { enabled: true },
            parameterTypes: { enabled: true },
            propertyDeclarationTypes: { enabled: true }
          } }
        } }
      }), stopped]);
      connection.sendNotification('initialized', {});
      return connection;
    })();
    return this.ready;
  }

  complete(source: string, filename: string, position: Position): Promise<CompletionList> {
    const result = this.enqueue(() => this.runCompletion(source, filename, position));
    return result;
  }

  hover(source: string, filename: string, position: Position): Promise<Hover | null> {
    return this.enqueue(async () => {
      const virtual = await this.prepare(source, filename);
      const offset = virtual.source.offsetAt(position);
      const mapped = mapSourceRange(virtual.mappings, offset, offset);
      if (!mapped) return null;
      const hover = await this.connection!.sendRequest<Hover | null>('textDocument/hover', {
        textDocument: { uri: virtual.uri }, position: virtual.document.positionAt(mapped.start)
      });
      if (!hover) return null;
      const range = hover.range && mapRange(hover.range, virtual);
      return { contents: hover.contents, ...(range ? { range } : {}) };
    });
  }

  definition(source: string, filename: string, position: Position, linkSupport = true): Promise<Location[] | LocationLink[]> {
    return this.enqueue(async () => {
      const virtual = await this.prepare(source, filename);
      const offset = virtual.source.offsetAt(position);
      const mapped = mapSourceRange(virtual.mappings, offset, offset);
      if (!mapped) return [];
      const importedPath = importedPathAt(source, offset);
      const response = await this.connection!.sendRequest<Location | Location[] | LocationLink[] | null>(
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
    return this.enqueue(async () => {
      const virtual = await this.prepare(source, filename);
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
      const hints = await this.connection!.sendRequest<InlayHint[] | null>('textDocument/inlayHint', {
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

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async prepare(source: string, filename: string): Promise<VirtualDocument> {
    const uri = pathToFileURL(`${filename}.svelte`).toString();
    const cached = this.virtuals.get(uri);
    if (cached?.source.getText() === source) return cached;
    const original = TextDocument.create(pathToFileURL(filename).toString(), 'svx', 0, source);
    const transformed = await transformSvx(source, filename, { validate: false });
    const version = (this.versions.get(uri) ?? 0) + 1;
    const virtual: VirtualDocument = {
      uri,
      source: original,
      document: TextDocument.create(uri, 'svelte', version, transformed.code),
      mappings: transformed.mappings
    };
    const connection = await this.start();
    if (version === 1) {
      connection.sendNotification('textDocument/didOpen', {
        textDocument: { uri, languageId: 'svelte', version, text: transformed.code }
      });
    } else {
      connection.sendNotification('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: transformed.code }]
      });
    }
    this.versions.set(uri, version);
    this.virtuals.set(uri, virtual);
    return virtual;
  }

  private async runCompletion(source: string, filename: string, position: Position): Promise<CompletionList> {
    const virtual = await this.prepare(source, filename);
    const sourceOffset = virtual.source.offsetAt(position);
    const offset = mapSourceRange(virtual.mappings, sourceOffset, sourceOffset);
    if (!offset) return { isIncomplete: false, items: [] };
    const response = await this.connection!.sendRequest<CompletionList | CompletionItem[] | null>(
      'textDocument/completion',
      { textDocument: { uri: virtual.uri }, position: virtual.document.positionAt(offset.start) }
    );
    const list = Array.isArray(response) ? { isIncomplete: false, items: response }
      : response ?? { isIncomplete: false, items: [] };
    return { ...list, items: list.items.map((item) => mapItem(item, virtual)).filter((item): item is CompletionItem => !!item) };
  }

  close(filename: string): void {
    const uri = pathToFileURL(`${filename}.svelte`).toString();
    this.virtuals.delete(uri);
    if (this.versions.delete(uri)) {
      this.connection?.sendNotification('textDocument/didClose', { textDocument: { uri } });
    }
  }

  dispose(): void {
    this.connection?.dispose();
    this.process?.kill();
  }
}
