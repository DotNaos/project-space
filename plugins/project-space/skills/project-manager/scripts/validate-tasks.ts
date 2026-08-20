#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

const requiredHeadings = [
  '# Project Manager Task Ledger',
  '## Critical path',
  '## Workers',
  '## Escalations',
  '## Completion checklist',
];

export function validateTasksDocument(source: string): string[] {
  const errors = requiredHeadings
    .filter((heading) => !source.includes(heading))
    .map((heading) => `missing required heading: ${heading}`);
  const workerRows = source
    .split('\n')
    .filter((line) => line.startsWith('| #') && !line.startsWith('| ---'));
  const header = source
    .split('\n')
    .find((line) => line.startsWith('| issue |'))
    ?.split('|').slice(1, -1).map((column) => column.trim().toLowerCase());
  const modelColumn = header?.indexOf('model/reasoning') ?? -1;
  if (modelColumn < 0) {
    errors.push('worker ledger must include a model/reasoning column');
  }
  const activeRows = workerRows.filter((line) => /\|\s*`?active`?\s*\|/i.test(line));
  if (activeRows.length > 3) {
    errors.push(`at most three active implementation workers are allowed; found ${activeRows.length}`);
  }
  if (workerRows.some((line) => {
    const columns = line.split('|').slice(1, -1).map((column) => column.trim());
    const modelAndReasoning = columns[modelColumn]?.replaceAll('`', '').trim() ?? '';
    return !/^[^\s/]+\/[^\s/]+$/.test(modelAndReasoning);
  })) {
    errors.push('each worker row must record a non-empty model/reasoning record');
  }
  if (workerRows.some((line) => !/Preview|no Preview/i.test(line))) {
    errors.push('each worker row must record Preview proof or an explicit no Preview alternative');
  }
  return errors;
}

if (import.meta.main) {
  const path = Bun.argv[2] ?? 'TASKS.md';
  const errors = validateTasksDocument(await readFile(path, 'utf8'));
  if (errors.length > 0) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  console.log(`valid Project Manager task ledger: ${path}`);
}
