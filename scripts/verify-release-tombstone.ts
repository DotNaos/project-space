#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseReleaseTombstone,
  releaseTombstoneDirectory,
} from './release-tombstone';
import { verifyReleaseTombstoneFromGitHub } from
  './release-tombstone-github';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [requestedPath] = process.argv.slice(2);
if (!requestedPath || process.argv.length !== 3) {
  throw new Error(
    'Usage: bun scripts/verify-release-tombstone.ts .github/release-tombstones/<tag>.json',
  );
}
const absolutePath = resolve(repositoryRoot, requestedPath);
const repositoryPath = relative(repositoryRoot, absolutePath);
if (
  dirname(repositoryPath) !== releaseTombstoneDirectory ||
  basename(repositoryPath) !== basename(requestedPath)
) {
  throw new Error(
    `Release tombstone must be a direct child of ${releaseTombstoneDirectory}.`,
  );
}
const tombstone = parseReleaseTombstone(
  readFileSync(absolutePath, 'utf8'),
  basename(repositoryPath),
);
const repository = process.env.GITHUB_REPOSITORY?.trim() ||
  'DotNaos/project-space';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('GITHUB_REPOSITORY must identify one owner/repository pair.');
}
const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required.');

await verifyReleaseTombstoneFromGitHub(tombstone, (path) =>
  fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'project-space-release-tombstone-verifier',
      'x-github-api-version': '2022-11-28',
    },
  })
);
console.log(
  `Verified unpublished ${tombstone.tag} at ${tombstone.sourceCommit} with exhausted run ${tombstone.exhaustedRunId} and verification run ${tombstone.verificationRunId}.`,
);
