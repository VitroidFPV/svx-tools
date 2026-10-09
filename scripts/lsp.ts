#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import {
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  type InitializeParams
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SvxDiagnostics } from '../src/diagnostics.ts';
import { SvxCompletions } from '../src/completions.ts';
import { formatSvx } from '../src/formatting.ts';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let workspaceRoot = process.cwd();
let checker: SvxDiagnostics;
let completions: SvxCompletions;

connection.onInitialize((params: InitializeParams) => {
  const rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  if (rootUri?.startsWith('file:')) workspaceRoot = fileURLToPath(rootUri);
  checker = new SvxDiagnostics(workspaceRoot);
  completions = new SvxCompletions(workspaceRoot);
  return { capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { triggerCharacters: ['.', '<', ':', '@'] },
    documentFormattingProvider: true
  } };
});

connection.onCompletion(async ({ textDocument, position }) => {
  const document = documents.get(textDocument.uri);
  if (!document || !textDocument.uri.startsWith('file:')) return null;
  const version = document.version;
  try {
    const filename = fileURLToPath(textDocument.uri);
    const result = await completions.complete(document.getText(), filename, position);
    const current = documents.get(textDocument.uri);
    if (!current) completions.close(filename);
    return current?.version === version ? result : null;
  } catch (error) {
    connection.console.error(`Failed to complete ${textDocument.uri}: ${String(error)}`);
    return null;
  }
});

connection.onDocumentFormatting(async ({ textDocument, options }) => {
  const document = documents.get(textDocument.uri);
  if (!document || !textDocument.uri.startsWith('file:')) return null;
  try {
    const formatted = await formatSvx(document.getText(), fileURLToPath(textDocument.uri), options.tabSize, options.insertSpaces);
    if (formatted === document.getText()) return [];
    return [{ range: {
      start: document.positionAt(0),
      end: document.positionAt(document.getText().length)
    }, newText: formatted }];
  } catch (error) {
    connection.console.error(`Failed to format ${textDocument.uri}: ${String(error)}`);
    return null;
  }
});

async function diagnose(uri: string): Promise<void> {
  const document = documents.get(uri);
  if (!document || !uri.startsWith('file:')) return;
  const version = document.version;

  try {
    const results = await checker.diagnose(document.getText(), fileURLToPath(uri));
    if (documents.get(uri)?.version !== version) return;
    connection.sendDiagnostics({
      uri,
      version,
      diagnostics: results.map((result) => ({
        range: {
          start: document.positionAt(result.start),
          end: document.positionAt(result.end)
        },
        message: result.message,
        severity: result.severity as DiagnosticSeverity | undefined,
        source: result.source ?? 'SVX',
        code: result.code
      }))
    });
  } catch (error) {
    connection.console.error(`Failed to check ${uri}: ${String(error)}`);
    connection.sendDiagnostics({ uri, version, diagnostics: [] });
  }
}

function schedule(uri: string, delay: number): void {
  clearTimeout(pending.get(uri));
  pending.set(uri, setTimeout(() => {
    pending.delete(uri);
    void diagnose(uri);
  }, delay));
}

documents.onDidOpen(({ document }) => schedule(document.uri, 0));
documents.onDidChangeContent(({ document }) => schedule(document.uri, 200));
documents.onDidClose(({ document }) => {
  clearTimeout(pending.get(document.uri));
  pending.delete(document.uri);
  if (document.uri.startsWith('file:')) completions.close(fileURLToPath(document.uri));
  if (document.uri.startsWith('file:')) checker.close(fileURLToPath(document.uri));
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

connection.onShutdown(() => completions.dispose());

documents.listen(connection);
connection.listen();
