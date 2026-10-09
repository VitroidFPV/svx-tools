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
language server integration check, and `bun run typecheck` for TypeScript
validation. `bun run probe path/to/file.svx` prints the MDsveX transformation
and source mapping details.
