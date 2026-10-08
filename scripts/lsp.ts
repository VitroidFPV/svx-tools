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

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let workspaceRoot = process.cwd();
let checker: SvxDiagnostics;

connection.onInitialize((params: InitializeParams) => {
  const rootUri = params.workspaceFolders?.[0]?.uri ?? params.rootUri;
  if (rootUri?.startsWith('file:')) workspaceRoot = fileURLToPath(rootUri);
  checker = new SvxDiagnostics(workspaceRoot);
  return { capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental } };
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
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
