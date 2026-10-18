import { readdirSync } from 'node:fs';
const files = readdirSync(new URL('.', import.meta.url))
  .filter(name => name.endsWith('.test.mjs'))
  .sort();

for (const file of files) await import(new URL(file, import.meta.url));
