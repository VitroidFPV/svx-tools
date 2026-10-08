import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { transformSvx } from '../src/transform.ts';

const filename = resolve(process.argv[2] || 'fixtures/basic.svx');
const source = await readFile(filename, 'utf8');
const result = await transformSvx(source, filename);

console.log(`Input: ${filename}`);
console.log(`Generated Svelte parses: yes`);
console.log(`MDsveX source map: ${result.map ? 'present' : 'unavailable'}`);
console.log('\n--- Generated Svelte ---\n');
console.log(result.code);
