import * as prettier from 'prettier';
import { rawSvelteBlockRanges } from './mappings.ts';

export async function formatSvx(source: string, filename: string, tabSize: number, insertSpaces: boolean): Promise<string> {
  const config = await prettier.resolveConfig(filename);
  let formatted = await prettier.format(source, {
    ...config,
    filepath: filename,
    parser: 'markdown',
    tabWidth: config?.tabWidth ?? tabSize,
    useTabs: config?.useTabs ?? !insertSpaces
  });
  const ranges = rawSvelteBlockRanges(formatted);
  for (const { start, end } of ranges.reverse()) {
    const block = await prettier.format(formatted.slice(start, end), {
      ...config,
      filepath: `${filename}.svelte`,
      parser: 'svelte',
      plugins: [...(config?.plugins ?? []), 'prettier-plugin-svelte'],
      tabWidth: config?.tabWidth ?? tabSize,
      useTabs: config?.useTabs ?? !insertSpaces
    });
    formatted = formatted.slice(0, start) + block.trimEnd() + formatted.slice(end);
  }
  return formatted;
}
