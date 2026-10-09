import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SvxLanguageFeatures } from '../src/language-features.ts';

test('maps import definitions, hover types, and inlay hints from virtual Svelte', async () => {
  const workspace = resolve(fileURLToPath(new URL('..', import.meta.url)), 'fixtures/alias');
  const filename = resolve(workspace, 'article.svx');
  const source = '<script lang="ts">\nimport Admonition from "$components/Admonition.svelte";\nlet count = 1;\n</script>\n<Admonition type="tip" />\n';
  const document = TextDocument.create(pathToFileURL(filename).toString(), 'svx', 0, source);
  const features = new SvxLanguageFeatures(workspace);

  try {
    const importPath = '$components/Admonition.svelte';
    const importStart = source.indexOf(importPath);
    const expectedOrigin = {
      start: document.positionAt(importStart), end: document.positionAt(importStart + importPath.length)
    };
    for (const section of ['$components', 'Admonition', 'svelte']) {
      const offset = source.indexOf(section, importStart) + 2;
      const definitions = await features.definition(source, filename, document.positionAt(offset));
      assert.ok(definitions.some((definition) =>
        'targetUri' in definition
        && definition.targetUri === pathToFileURL(resolve(workspace, 'components/Admonition.svelte')).toString()
        && JSON.stringify(definition.originSelectionRange) === JSON.stringify(expectedOrigin)), JSON.stringify(definitions));
    }
    const componentDefinitions = await features.definition(source, filename, document.positionAt(source.indexOf('<Admonition') + 2));
    assert.ok(componentDefinitions.some((definition) =>
      'targetUri' in definition && definition.targetUri === document.uri
      && definition.targetSelectionRange.start.line === 1), JSON.stringify(componentDefinitions));

    const hover = await features.hover(source, filename, document.positionAt(source.indexOf('count')));
    assert.ok(JSON.stringify(hover).includes('number'), JSON.stringify(hover));

    const hints = await features.inlayHints(source, filename, {
      start: document.positionAt(0), end: document.positionAt(source.length)
    });
    assert.ok(hints.some((hint) => hint.position.line === 2 && JSON.stringify(hint.label).includes('number')), JSON.stringify(hints));
  } finally {
    features.close(filename);
    features.dispose();
  }
});
