# SVX tools

Early language support for MDsveX `.svx` files in Zed
and VS Code compatible editors.

The extensions recognize `.svx` files, highlight their Markdown and embedded
code, and report diagnostics from Svelte and TypeScript. Diagnostics appear at
their original locations only when the position can be mapped reliably.

## Zed

The Zed extension is in `editors/zed`. Until it is available in Zed's extension
gallery, you can try it as a development extension:

1. Install Bun and Rust, then run `bun install` and `bun run build:lsp` in this repository.
2. In Zed, choose **Extensions → Install Dev Extension** and select `editors/zed`.
3. Open a `.svx` file. `fixtures/error.svx` has five expected diagnostics.

For completion, open `fixtures/completion.svx` and invoke completions after `cou`
or `oncl`. For formatting, run **Format Document** on `fixtures/formatting.svx`
and compare it with `fixtures/formatting.expected.svx`.

The extension installs the published `svx-tools` language server into Zed's own
storage when you open another project. It runs on Zed's managed Node runtime,
so users do not need Bun or a dependency in each project. With this repository
open, the development extension uses the local build instead. To test the local
build while editing another project, set Zed's `lsp.svx-language-server.binary`
to your Node executable and the built server:

```json
{
  "lsp": {
    "svx-language-server": {
      "binary": {
        "path": "/absolute/path/to/node",
        "arguments": ["/absolute/path/to/svx-tools/dist/lsp.cjs", "--stdio"]
      }
    }
  }
}
```

Rebuilding the Zed extension alone does not update the published server copy in
Zed's storage. Install Zed's Svelte extension for highlighting in raw Svelte blocks.

The Zed language server offers Svelte and TypeScript completions, hover types,
go to definition, and type inlay hints in unchanged raw Svelte regions. Import
paths also navigate to files resolved through the project's TypeScript aliases.
Formatting covers Markdown, fenced code, and raw Svelte script and style blocks.
Enable inlay hints in Zed with `"inlay_hints": { "enabled": true }`.

## VS Code compatible editors

The extension in `editors/vscode` is available for development testing, but
has not been packaged for an extension marketplace. Run `bun install` and
`bun run build:vscode`, then launch an Extension Development Host:

```sh
code --extensionDevelopmentPath="$(pwd)/editors/vscode" .
```

## Development

Run `bun test` for the focused checks, `bun run test:features` for the Node based
backend integration checks, and `bun run typecheck` for TypeScript
validation. `bun run probe path/to/file.svx` prints the MDsveX transformation
and source mapping details.

Diagnostics, completion, hover, definitions and inlay hints share one Svelte /
TypeScript worker per workspace backend. Documents use the nearest tsconfig or
jsconfig and share its project; a workspace without a config uses one inferred
project. Closing a document removes its virtual root and mappings. Projects are
released when their last SVX document closes, and the worker exits when the
backend becomes idle or is disposed. VS Code deactivation and LSP shutdown await
disposal. Formatting still uses the existing formatter.

The backend reads project files and installed dependencies without modifying
them. Generated type shims stay in memory. Vite configuration uses its module
runner and loads Svelte language options without running the project's build
pipeline. Configuration code that requires real file writes is blocked.
Formatting returns edits for the editor to apply when requested.

The worker owns a small lifecycle adaptation to `svelte-language-server` **0.18.4**.
It checks the version and service-file hash before applying the adaptation in
memory; it does not modify installed dependencies. Both builds include
`svelte-worker.cjs` and `read-only-filesystem.cjs`, and npm installations need no
patch tool or Bun runtime. The config loader is pinned to `@sveltejs/load-config`
**0.2.3** and hash-checked as well.
Upgrading this dependency requires updating the adaptation and passing the real
close/reopen integration tests and clean-package smoke test.
