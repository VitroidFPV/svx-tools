import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { transformSvx } from '../src/transform.ts';

const filename = resolve(process.argv[2] || 'fixtures/basic.svx');
const source = await readFile(filename, 'utf8');
const result = await transformSvx(source, filename);

console.log(`Input: ${filename}`);
console.log(`Generated Svelte parses: yes`);
console.log(`MDsveX source map: ${result.map ? 'present' : 'unavailable'}`);
console.log(`MDsveX data: ${JSON.stringify(result.data)}`);
console.log(`Exact source spans: ${result.mappings.length}`);
const lineAt = (text: string, offset: number) => text.slice(0, offset).split('\n').length;
for (const mapping of result.mappings) {
  console.log(
    `  SVX line ${lineAt(source, mapping.sourceStart)} -> generated line ${lineAt(result.code, mapping.generatedStart)}`
  );
}
console.log('\n--- Generated Svelte ---\n');
console.log(result.code);
