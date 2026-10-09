import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createMessageConnection, type MessageConnection } from 'vscode-jsonrpc/node.js';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { CompletionItem, CompletionList, Position, Range, TextEdit } from 'vscode-languageserver/node';
import { mapGeneratedRange, mapSourceRange, type ExactMapping } from './mappings.ts';
import { transformSvx } from './transform.ts';

interface VirtualDocument {
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

export class SvxCompletions {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: MessageConnection;
  private ready?: Promise<MessageConnection>;
  private readonly versions = new Map<string, number>();
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
        capabilities: { workspace: { configuration: true } }
      }), stopped]);
      connection.sendNotification('initialized', {});
      return connection;
    })();
    return this.ready;
  }

  complete(source: string, filename: string, position: Position): Promise<CompletionList> {
    const result = this.queue.then(() => this.run(source, filename, position));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(source: string, filename: string, position: Position): Promise<CompletionList> {
    const original = TextDocument.create(pathToFileURL(filename).toString(), 'svx', 0, source);
    const sourceOffset = original.offsetAt(position);
    const transformed = await transformSvx(source, filename, { validate: false });
    const offset = mapSourceRange(transformed.mappings, sourceOffset, sourceOffset);
    if (!offset) return { isIncomplete: false, items: [] };

    const uri = pathToFileURL(`${filename}.svelte`).toString();
    const version = (this.versions.get(uri) ?? 0) + 1;
    const virtual: VirtualDocument = {
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
    const response = await connection.sendRequest<CompletionList | CompletionItem[] | null>(
      'textDocument/completion',
      { textDocument: { uri }, position: virtual.document.positionAt(offset.start) }
    );
    const list = Array.isArray(response) ? { isIncomplete: false, items: response }
      : response ?? { isIncomplete: false, items: [] };
    return { ...list, items: list.items.map((item) => mapItem(item, virtual)).filter((item): item is CompletionItem => !!item) };
  }

  close(filename: string): void {
    const uri = pathToFileURL(`${filename}.svelte`).toString();
    if (this.versions.delete(uri)) {
      this.connection?.sendNotification('textDocument/didClose', { textDocument: { uri } });
    }
  }

  dispose(): void {
    this.connection?.dispose();
    this.process?.kill();
  }
}
