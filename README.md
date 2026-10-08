# SVX tools prototype

This is an early experiment toward MDsveX language support in VS Code and Zed.
It currently checks the MDsveX-to-Svelte handoff and provides basic `.svx`
recognition and highlighting for VS Code. There is no language server yet.

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

## Try the VS Code syntax extension

With the VS Code CLI available, launch an Extension Development Host:

```sh
code --extensionDevelopmentPath="$(pwd)/editors/vscode" .
```

Open `fixtures/basic.svx` in that window.
This extension currently highlights Markdown and `<script>`/`<style>` blocks.
It does not yet provide Svelte expressions, component completion, diagnostics,
or formatting.

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
