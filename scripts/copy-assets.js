#!/usr/bin/env node
/** Copies non-TypeScript build assets into dist/ (schema.sql is read at runtime). */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const assets = [
  ['src/adapters/persistence/schema.sql', 'dist/adapters/persistence/schema.sql'],
  // The catalogue store reads its schema next to the compiled module, so this
  // file has to travel into dist or `pnpm catalogue` cannot open a database.
  ['src/catalogue/schema.sql', 'dist/catalogue/schema.sql'],
  ['src/cli/doctor.js', 'dist/cli/doctor.js'],
];

for (const [from, to] of assets) {
  if (from.endsWith('.js')) continue; // compiled output, not source
  const target = join(root, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
}
console.log('assets copied');
