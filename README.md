# SVX tools prototype

This is an early experiment toward MDsveX language support in VS Code and Zed.
It checks the MDsveX-to-Svelte handoff and provides basic `.svx` recognition,
highlighting, and diagnostics for VS Code and compatible editors. A small LSP
server now exposes diagnostics to Zed.

## Run the transformation probe

Requires Bun 1.4 or newer.

```sh
bun install
bun run probe
bun test
bun run typecheck
```

Pass another `.svx` file with `bun run probe path/to/file.svx`. The command
prints the generated Svelte, MDsveX data, source spans, and whether it supplied a source map.
It also parses the output with the Svelte compiler, including Svelte 5 syntax.

## Try the VS Code extension

Install dependencies and build the extension from the repository root:

```sh
bun install
bun run build:vscode
```

With the VS Code CLI available, launch an Extension Development Host:

```sh
code --extensionDevelopmentPath="$(pwd)/editors/vscode" .
```

Cursor can use `editors/vscode` as its extension development path. Reload the
development window after rebuilding. Open `fixtures/error.svx`: it should show
four errors (a script type mismatch and three missing names) plus an image
accessibility warning. The diagnostics should point to the original SVX lines.

The VS Code extension highlights Markdown and `<script>`/`<style>` blocks.
Diagnostics come from Svelte's checking API and are shown only when their
generated ranges map exactly to the SVX source. For files without a script,
the virtual Svelte document enables JavaScript checking; files with a
JavaScript script still follow that script's checking settings.

## Try the Zed extension

Install dependencies with `bun install` from the repository root. Launch Zed
from a shell where `bun` is available on `PATH` (for example, `zed .`). Use
**Extensions → Install Dev Extension** and select `editors/zed`. Open the
`svx-tools` repository as the worktree, then open `fixtures/error.svx`. The
file should be recognized as SVX and show the same four errors and one warning.
After using **Rebuild Extension**, close and reopen the `.svx` file. If the
diagnostics remain absent, restart Zed; an extension reload can stop the active
language server without restarting it for an already open file.

This local prototype launches `scripts/lsp.ts` from the open worktree, so it
currently works when the worktree is this repository. Zed also needs Rust to
compile the extension. Install Zed's Svelte extension for highlighting inside
raw Svelte blocks. The SVX grammar also highlights Markdown inline content and
injects languages into fenced code blocks. Completion, formatting, and broader
source mapping remain future work for both editors.

## Position mapping

MDsveX 0.12.8 returns `{ code, data, map }`. `data.fm` contains parsed
frontmatter when present. Its source code currently sets `map: ''` for every
transformed file; the standalone `compile()` API delegates to the same
preprocessor. Svelte `preprocess()` consequently returns `map: null`. The
Svelte compiler can produce a JavaScript source map, but its source content
is the generated Svelte, not the original SVX.

The prototype now finds exact, unique matches for `<script>` and `<style>` blocks whose opening tag is on one line, raw tag lines, and standalone Svelte expressions or block
directives outside Markdown fences. `mapGeneratedRange` translates an offset range only when it lies entirely within one such span;
it returns `null` for generated Markdown, frontmatter, changed content, and
ambiguous matches. These are conservative prototype mappings, not a full
source map. They use default MDsveX settings; custom plugins and layouts need
validation before relying on them for editor diagnostics or edits. Zed also
needs a grammar that represents Markdown and Svelte syntax in the same file.
