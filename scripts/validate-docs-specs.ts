#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import {
  behaviorSensitivePaths,
  changedChangeArtifacts,
  validateRepository,
} from './docs-specs/validator';

const options = parseOptions(process.argv.slice(2));
const report = validateRepository();
const diagnostics = [...report.diagnostics];
const base = options.base ?? process.env.DOCS_SPECS_BASE;

if (base) {
  const changedPaths = gitChangedPaths(base);
  const behaviorPaths = behaviorSensitivePaths(changedPaths);
  if (behaviorPaths.length > 0 && changedChangeArtifacts(changedPaths).length === 0) {
    diagnostics.push({
      path: behaviorPaths[0],
      message: `Observable or operational code changed in ${behaviorPaths.length} path(s), but no change-spec artifact changed. Add a change specification or explicitly document why requirements are not applicable.`,
    });
  }
}

const result = {
  schema: 'project-space.docs-spec-validation/v1',
  conclusion: diagnostics.length === 0 ? 'passed-structural' : 'failed',
  changes: report.changes,
  requirements: report.requirements,
  templates: report.templates,
  diagnostics,
  semanticProof: false,
};

if (options.format === 'json') {
  console.log(JSON.stringify(result, null, 2));
} else if (diagnostics.length === 0) {
  console.log(
    `Documentation structure is valid: ${report.requirements} current requirements, ${report.changes} change specification(s), and ${report.templates} template set.`,
  );
  console.log('This proves structural conformance only; implementation correctness still requires the recorded tests, evidence, and review.');
} else {
  console.error(`Documentation validation failed with ${diagnostics.length} error(s):`);
  for (const diagnostic of diagnostics) {
    console.error(`- ${diagnostic.path}${diagnostic.line ? `:${diagnostic.line}` : ''}: ${diagnostic.message}`);
  }
}

if (diagnostics.length > 0) process.exit(1);

function gitChangedPaths(base: string) {
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Unable to compare documentation coverage with ${base}.`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

function parseOptions(arguments_: string[]) {
  let base: string | undefined;
  let format: 'json' | 'text' = 'text';
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--base') {
      base = arguments_[index + 1];
      if (!base) throw new Error('--base requires a Git revision.');
      index += 1;
    } else if (argument === '--format') {
      const value = arguments_[index + 1];
      if (value !== 'json' && value !== 'text') throw new Error('--format must be json or text.');
      format = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { base, format };
}
