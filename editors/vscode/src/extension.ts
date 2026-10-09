import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { SvxLanguageBackend } from '../../../src/language-backend.ts';

const checkers = new Map<string, SvxLanguageBackend>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let active = false;

export function activate(context: vscode.ExtensionContext): void {
  active = true;
  const collection = vscode.languages.createDiagnosticCollection('svx');
  const output = vscode.window.createOutputChannel('SVX');
  context.subscriptions.push(collection, output, { dispose() { void deactivate(); } });

  async function update(document: vscode.TextDocument): Promise<void> {
    if (!active) return;
    const version = document.version;
    const workspacePath = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
      ?? dirname(document.uri.fsPath);
    let checker = checkers.get(workspacePath);
    if (!checker) {
      checker = new SvxLanguageBackend(workspacePath);
      checkers.set(workspacePath, checker);
    }

    try {
      const results = await checker.diagnose(document.getText(), document.uri.fsPath);
      if (!active || document.isClosed || document.version !== version) return;
      collection.set(document.uri, results.map((result) => {
        const range = new vscode.Range(
          document.positionAt(result.start),
          document.positionAt(result.end)
        );
        const severity = result.severity === 2 ? vscode.DiagnosticSeverity.Warning
          : result.severity === 3 ? vscode.DiagnosticSeverity.Information
          : result.severity === 4 ? vscode.DiagnosticSeverity.Hint
          : vscode.DiagnosticSeverity.Error;
        const diagnostic = new vscode.Diagnostic(range, result.message, severity);
        diagnostic.source = result.source ?? 'SVX';
        diagnostic.code = result.code;
        return diagnostic;
      }));
    } catch (error) {
      if (!active) return;
      collection.delete(document.uri);
      output.appendLine(`Failed to check ${document.uri.fsPath}: ${String(error)}`);
    }
  }

  function schedule(document: vscode.TextDocument, delay = 300): void {
    if (document.languageId !== 'svx' || document.uri.scheme !== 'file') return;
    const key = document.uri.toString();
    clearTimeout(pending.get(key));
    pending.set(key, setTimeout(() => {
      pending.delete(key);
      void update(document);
    }, delay));
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => schedule(document, 0)),
    vscode.workspace.onDidChangeTextDocument(({ document }) => schedule(document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      clearTimeout(pending.get(key));
      pending.delete(key);
      const workspacePath = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
        ?? dirname(document.uri.fsPath);
      void checkers.get(workspacePath)?.close(document.uri.fsPath).catch(error => output.appendLine(String(error)));
      collection.delete(document.uri);
    })
  );

  for (const document of vscode.workspace.textDocuments) schedule(document, 0);
}

export async function deactivate(): Promise<void> {
  active = false;
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  const backends = [...checkers.values()];
  checkers.clear();
  await Promise.all(backends.map(backend => backend.dispose()));
}
