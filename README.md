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
prints the generated Svelte and whether MDsveX supplied a source map. It also
parses the output with the Svelte compiler, including Svelte 5 syntax.

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

MDsveX currently returns an empty map for the sample file. Before routing
Svelte language-server diagnostics or edits into SVX, we need a reliable way
to translate generated positions back to the original document. The probe
makes this limitation visible. Zed support will also need a grammar that can
represent Markdown and Svelte syntax in the same file.
