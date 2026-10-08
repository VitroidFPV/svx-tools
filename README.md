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
prints the generated Svelte, MDsveX data, and whether it supplied a source map.
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

## Next experiment

MDsveX 0.12.8 returns `{ code, data, map }`. `data.fm` contains parsed
frontmatter when present. Its source code currently sets `map: ''` for every
transformed file; the standalone `compile()` API delegates to the same
preprocessor. Svelte `preprocess()` consequently returns `map: null`. The
Svelte compiler can produce a JavaScript source map, but its source content
is the generated Svelte, not the original SVX.

Before routing Svelte language-server diagnostics or edits into SVX, we need
a mapping from generated Svelte positions to original SVX positions. A first
version could map unchanged script and Svelte markup ranges, leaving generated
Markdown ranges unmapped. Frontmatter, layouts, and plugins need separate
checks. Zed support will also need a grammar that represents Markdown and
Svelte syntax in the same file.
