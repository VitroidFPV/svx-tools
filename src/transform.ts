import { extname } from 'node:path';
import { mdsvex } from 'mdsvex';
import { parse } from 'svelte/compiler';

export async function transformSvx(source: string, filename: string) {
  const extension = extname(filename);
  const result = await mdsvex({ extensions: [extension] }).markup({
    content: source,
    filename
  });

  if (!result) {
    throw new Error(`MDsveX did not transform ${filename}`);
  }

  // Parse the generated Svelte now; this proves the handoff works without
  // claiming that generated positions are positions in the original SVX file.
  parse(result.code, { filename });

  return {
    code: result.code,
    data: result.data ?? {},
    map: result.map || null
  };
}
