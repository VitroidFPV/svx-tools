import { extname } from 'node:path';
import { mdsvex } from 'mdsvex';
import { parse } from 'svelte/compiler';
import { createExactMappings } from './mappings.ts';

export async function transformSvx(source: string, filename: string, options: { validate?: boolean } = {}) {
  const extension = extname(filename);
  const result = await mdsvex({ extensions: [extension] }).markup({
    content: source,
    filename
  });

  if (!result) {
    throw new Error(`MDsveX did not transform ${filename}`);
  }

  // Validate complete documents, but allow incomplete syntax during completion.
  if (options.validate !== false) parse(result.code, { filename });

  return {
    code: result.code,
    data: result.data ?? {},
    map: result.map || null,
    mappings: createExactMappings(source, result.code)
  };
}
