#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

const requiredHeadings = [
  '# Project Manager Task Ledger',
  '## Critical path',
  '## Production blocker intake',
  '## Workers',
  '## Escalations',
  '## Completion checklist',
];

export function validateTasksDocument(source: string): string[] {
  const errors = requiredHeadings
    .filter((heading) => !source.includes(heading))
    .map((heading) => `missing required heading: ${heading}`);
  const sourceLines = source.split('\n');
  const productionHeaderIndex = sourceLines.findIndex((line) => line.startsWith('| bug/incident |'));
  const productionHeader = productionHeaderIndex >= 0 ? sourceLines[productionHeaderIndex] : undefined;
  const productionColumns = productionHeader
    ?.split('|').slice(1, -1).map((column) => column.trim().toLowerCase());
  const requiredProductionColumns = [
    'bug/incident',
    'search and issue action',
    'affected task/stage',
    'dependency edge and queue position',
    'severity/owner',
    'recovery and unblock evidence',
  ];
  if (!productionHeader || !requiredProductionColumns.every((column) => productionColumns?.includes(column))) {
    errors.push('production blocker ledger must record search, issue action, affected stage, dependency edge, severity/owner, and recovery evidence');
  } else {
    const nextHeadingIndex = sourceLines.findIndex((line, index) => index > productionHeaderIndex && line.startsWith('## '));
    const productionRows = sourceLines
      .slice(productionHeaderIndex + 1, nextHeadingIndex >= 0 ? nextHeadingIndex : sourceLines.length)
      .filter((line) => line.startsWith('|') && !line.startsWith('| ---') && line !== productionHeader);
    if (productionRows.length === 0) {
      errors.push('production blocker ledger must contain a no-blocker record or a reproduced blocker');
    }
    for (const line of productionRows) {
      const columns = line.split('|').slice(1, -1).map((column) => column.trim());
      if (columns.length !== requiredProductionColumns.length) {
        errors.push('each production blocker row must record all six required fields');
        continue;
      }
      if (/^none$/i.test(columns[0].replaceAll('`', '').trim())) continue;
      if (columns.some((column) => column === '' || /^<[^>]+>$/.test(column))) {
        errors.push('each reproduced production blocker must record concrete evidence, issue action, affected stage, queue edge, owner, and recovery');
      }
    }
  }
  const workersHeadingIndex = sourceLines.findIndex((line) => line === '## Workers');
  const nextWorkersHeadingIndex = sourceLines.findIndex((line, index) => index > workersHeadingIndex && line.startsWith('## '));
  const workerSection = workersHeadingIndex >= 0
    ? sourceLines.slice(workersHeadingIndex + 1, nextWorkersHeadingIndex >= 0 ? nextWorkersHeadingIndex : sourceLines.length)
    : [];
  const workerRows = workerSection
    .filter((line) => line.startsWith('| #') && !line.startsWith('| ---'));
  const header = workerSection
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
