#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import {
  behaviorSensitivePaths,
  changedChangeArtifacts,
  validateRepository,
} from './docs-specs/validator';
import { materializeGitIndexSnapshot } from './git-index-snapshot';

const options = parseOptions(process.argv.slice(2));
const stagedRoot = options.staged ? stagedDocumentationRoot() : undefined;
try {
  const report = validateRepository(stagedRoot);
  const diagnostics = [...report.diagnostics];
  const base = options.base ?? process.env.DOCS_SPECS_BASE;

  if (base || options.staged) {
    const changedPaths = options.staged ? gitStagedPaths(base) : gitChangedPaths(base!);
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
  if (diagnostics.length > 0) process.exitCode = 1;
} finally {
  if (stagedRoot) rmSync(stagedRoot, { force: true, recursive: true });
}

function gitChangedPaths(base: string) {
  const result = spawnSync('git', ['diff', '--name-only', '--no-renames', `${base}...HEAD`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Unable to compare documentation coverage with ${base}.`);
  }
  return result.stdout.split('\n').filter(Boolean);
}

function gitStagedPaths(base?: string) {
  const comparison = base
    ? gitOutput(['merge-base', base, 'HEAD']).toString().trim()
    : 'HEAD';
  return gitOutput(['diff', '--cached', '--name-only', '--no-renames', comparison])
    .toString()
    .split('\n')
    .filter(Boolean);
}

function stagedDocumentationRoot() {
  return materializeGitIndexSnapshot('project-space-staged-docs-');
}

function gitOutput(arguments_: string[]) {
  const result = spawnSync('git', arguments_, { encoding: null });
  if (result.status !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${arguments_.join(' ')} failed.`);
  }
  return result.stdout;
}

function parseOptions(arguments_: string[]) {
  let base: string | undefined;
  let format: 'json' | 'text' = 'text';
  let staged = false;
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
    } else if (argument === '--staged') {
      staged = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { base, format, staged };
}
