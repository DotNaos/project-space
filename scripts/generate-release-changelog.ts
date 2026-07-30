#!/usr/bin/env bun

import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { readReleaseCatalog } from '../apps/docs/lib/releases/catalog';
import { generatedReleaseChangelogSource } from '../apps/docs/lib/releases/changelog-source';

const repositoryRoot = resolve(import.meta.dir, '..');
const entriesDirectory = resolve(
  repositoryRoot,
  'apps/docs/content/docs/releases/entries',
);
const outputPath = resolve(
  repositoryRoot,
  'apps/docs/content/docs/changelog/release-entries.generated.json',
);
const check = process.argv.slice(2).includes('--check');
const catalog = readReleaseCatalog(entriesDirectory);

if (!catalog.ok) {
  fail(catalog.errors);
}

const output = `${JSON.stringify(
  generatedReleaseChangelogSource(catalog.catalog.entries),
  null,
  2,
)}\n`;

if (check) {
  let current = '';
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    fail('Generated release changelog source is missing.');
  }
  if (current !== output) {
    fail(
      'Generated release changelog source is stale. Run bun run docs:release:source.',
    );
  }
  console.log('Generated release changelog source is current.');
} else {
  writeFileSync(outputPath, output, 'utf8');
  console.log(
    'Updated apps/docs/content/docs/changelog/release-entries.generated.json.',
  );
}

function fail(messages: string | string[]): never {
  const list = Array.isArray(messages) ? messages : [messages];
  for (const message of list) console.error(`- ${message}`);
  process.exit(1);
}
