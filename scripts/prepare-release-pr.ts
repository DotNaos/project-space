#!/usr/bin/env bun

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { parseReleaseCatalog } from '../apps/docs/lib/releases/catalog';
import { parseReleaseEntryMdx } from '../apps/docs/lib/releases/mdx';
import { expectedVersionForBump } from '../apps/docs/lib/releases/semver';
import {
  prepareReleaseEntryIdentity,
  prepareReleaseIdentityBundle,
  readReleaseIdentitySources,
  releaseIdentityPaths,
  validateReleaseIdentityBundle,
} from './release-identity';

type Options = {
  base: string;
  format: 'json' | 'text';
  pullRequest: number;
  version: string;
};

type PreparationDependencies = {
  assertUniqueRelease?: (version: string) => Promise<void>;
  validateWritten?: () => Promise<void>;
};

type Result = {
  baseSha: string;
  bump: string;
  headSha: string;
  paths: string[];
  pullRequest: number;
  status: 'already-prepared' | 'prepared';
  version: string;
};

const entryDirectory = 'apps/docs/content/docs/releases/entries';

export async function prepareReleasePullRequest(
  input: Options,
  dependencies: PreparationDependencies = {},
): Promise<Result> {
  await run(['git', 'fetch', '--no-tags', 'origin', 'main']);
  const baseSha = await gitText('rev-parse', `${input.base}^{commit}`);
  const originMainSha = await gitText('rev-parse', 'origin/main^{commit}');
  if (baseSha !== originMainSha) {
    throw new Error(
      `Base ${baseSha} is not the fetched origin/main ${originMainSha}; stale main preparation is refused.`,
    );
  }
  const headSha = await gitText('rev-parse', 'HEAD^{commit}');
  await run(['git', 'merge-base', '--is-ancestor', baseSha, headSha]);

  const currentVersion = packageVersion(
    await gitText('show', `${baseSha}:package.json`),
  );
  const baseSources = new Map<string, string>();
  for (const path of releaseIdentityPaths) {
    baseSources.set(path, await gitText('show', `${baseSha}:${path}`));
  }
  const baseErrors = validateReleaseIdentityBundle(
    baseSources,
    currentVersion,
  );
  if (baseErrors.length > 0) throw new Error(baseErrors.join('\n'));

  const entryPath = `${entryDirectory}/${input.pullRequest}.mdx`;
  const expectedPaths = [...releaseIdentityPaths, entryPath].sort();
  if (!existsSync(entryPath)) {
    throw new Error(
      `${entryPath} must be authored completely before preparation; use __VERSION__ and __PR_NUMBER__ only for its identity fields.`,
    );
  }

  const status = await worktreeStatus();
  const unexpected = status.filter(
    ({ path }) => !expectedPaths.includes(path),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `Unrelated worktree changes are not allowed: ${unexpected.map(({ path }) => path).join(', ')}.`,
    );
  }
  if (status.some(({ code }) => code !== '??' && code[0] !== ' ')) {
    throw new Error('Staged input is ambiguous; unstage it before release preparation.');
  }

  const workspaceSources = readReleaseIdentitySources();
  const rawEntry = readFileSync(entryPath, 'utf8');
  const alreadyPrepared =
    validateReleaseIdentityBundle(workspaceSources, input.version).length === 0 &&
    validateEntry(rawEntry, entryPath, input).length === 0;
  if (alreadyPrepared) {
    if (status.length !== 0 && status.length !== expectedPaths.length) {
      throw new Error('The prepared bundle is incomplete or mixed with committed identity files.');
    }
    await validateCatalog(input.version, input.pullRequest);
    return result('already-prepared');
  }

  const allowedFirstStatus =
    status.length === 1 &&
    status[0]?.code === '??' &&
    status[0]?.path === entryPath;
  if (!allowedFirstStatus) {
    throw new Error(
      'Input must be clean except for the new authored release entry; partial release bundles are refused.',
    );
  }
  const intendedForBump = intendedVersion(
    rawEntry,
    currentVersion,
    input.pullRequest,
  );
  if (intendedForBump !== input.version) {
    throw new Error(
      `Version ${input.version} is stale or inconsistent; current main and the authored bump require ${intendedForBump}.`,
    );
  }

  const preparedEntry = prepareReleaseEntryIdentity(
    rawEntry,
    input.pullRequest,
    input.version,
  );
  const entryErrors = validateEntry(preparedEntry, entryPath, input);
  if (entryErrors.length > 0) throw new Error(entryErrors.join('\n'));
  await (dependencies.assertUniqueRelease ?? assertUniqueRelease)(input.version);

  const preparedSources = prepareReleaseIdentityBundle(
    workspaceSources,
    currentVersion,
    input.version,
  );
  const writes = new Map(preparedSources);
  writes.set(entryPath, preparedEntry);
  await validateCatalog(input.version, input.pullRequest, preparedEntry);
  await writeTransaction(writes, async () => {
    const writtenErrors = validateReleaseIdentityBundle(
      readReleaseIdentitySources(),
      input.version,
    );
    if (writtenErrors.length > 0) throw new Error(writtenErrors.join('\n'));
    await validateCatalog(input.version, input.pullRequest);
    await dependencies.validateWritten?.();
  });
  return result('prepared');

  function result(status: Result['status']): Result {
    return {
      baseSha,
      bump: releaseBump(readFileSync(entryPath, 'utf8'), entryPath),
      headSha,
      paths: expectedPaths,
      pullRequest: input.pullRequest,
      status,
      version: input.version,
    };
  }
}

function intendedVersion(
  source: string,
  currentVersion: string,
  pullRequest: number,
) {
  const bump = releaseBump(
    source
      .replace('version: "__VERSION__"', `version: "${currentVersion}"`)
      .replace('pullRequest: __PR_NUMBER__', `pullRequest: ${pullRequest}`),
    `${pullRequest}.mdx`,
  );
  return expectedVersionForBump(currentVersion, bump);
}

function releaseBump(source: string, path: string) {
  const parsed = parseReleaseEntryMdx(source, path.split('/').at(-1) ?? path);
  if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
  return parsed.entry.bump;
}

function validateEntry(source: string, path: string, input: Options) {
  const parsed = parseReleaseEntryMdx(source, path.split('/').at(-1) ?? path);
  if (!parsed.ok) return parsed.errors;
  const errors: string[] = [];
  if (parsed.entry.pullRequest !== input.pullRequest) {
    errors.push(`Release entry must belong to PR #${input.pullRequest}.`);
  }
  if (parsed.entry.version !== input.version) {
    errors.push(`Release entry must use version ${input.version}.`);
  }
  return errors;
}

async function validateCatalog(
  version: string,
  pullRequest: number,
  preparedEntry?: string,
) {
  const entries = new Map<string, string>();
  for (const path of (await gitText('ls-files', `${entryDirectory}/*.mdx`))
    .split('\n')
    .filter(Boolean)) {
    entries.set(path.split('/').at(-1)!, readFileSync(path, 'utf8'));
  }
  const target = `${pullRequest}.mdx`;
  entries.set(
    target,
    preparedEntry ?? readFileSync(`${entryDirectory}/${target}`, 'utf8'),
  );
  const catalog = parseReleaseCatalog(entries);
  if (!catalog.ok) throw new Error(catalog.errors.join('\n'));
  if (catalog.catalog.entries[0]?.version !== version) {
    throw new Error(`Prepared version ${version} is not the latest release entry.`);
  }
}

async function assertUniqueRelease(version: string) {
  const tag = `v${version}`;
  if (
    (await gitText('tag', '--list', tag)) !== '' ||
    (await gitText('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) !== ''
  ) {
    throw new Error(`Git tag ${tag} already exists.`);
  }
  const response = await fetch(
    `https://api.github.com/repos/DotNaos/project-space/releases/tags/v${version}`,
    { headers: { accept: 'application/vnd.github+json' } },
  );
  if (response.status !== 404) {
    if (response.ok) throw new Error(`GitHub Release v${version} already exists.`);
    throw new Error(`GitHub Release uniqueness check failed with HTTP ${response.status}.`);
  }
}

async function writeTransaction(
  writes: Map<string, string>,
  validateWritten: () => Promise<void>,
) {
  const originals = new Map<string, string>();
  const temporary: string[] = [];
  try {
    for (const [path, source] of writes) {
      originals.set(path, readFileSync(path, 'utf8'));
      const temp = `${path}.release-preparation.tmp`;
      writeFileSync(temp, source, { flag: 'wx' });
      temporary.push(temp);
    }
    for (const [path] of writes) {
      renameSync(`${path}.release-preparation.tmp`, path);
    }
    await validateWritten();
  } catch (error) {
    for (const [path, source] of originals) writeFileSync(path, source);
    throw error;
  } finally {
    for (const path of temporary) rmSync(path, { force: true });
  }
}

async function worktreeStatus() {
  const output = await run([
    'git',
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (!output) return [];
  return output.split('\0').filter(Boolean).map((entry) => ({
    code: entry.slice(0, 2),
    path: entry.slice(3),
  }));
}

function packageVersion(source: string) {
  const value = JSON.parse(source) as { version?: unknown };
  if (typeof value.version !== 'string') {
    throw new Error('package.json has no string version.');
  }
  return value.version;
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined) usage();
    values.set(key, value);
  }
  const pullRequest = Number(values.get('--pull-request'));
  const version = values.get('--version') ?? '';
  const format = values.get('--format') ?? 'text';
  if (!Number.isSafeInteger(pullRequest) || pullRequest <= 0) usage();
  if (!/^\d+\.\d+\.\d+$/.test(version)) usage();
  if (format !== 'json' && format !== 'text') usage();
  return {
    base: values.get('--base') ?? 'origin/main',
    format,
    pullRequest,
    version,
  };
}

function usage(): never {
  throw new Error(
    'Usage: bun scripts/prepare-release-pr.ts --pull-request <number> --version <semver> [--base origin/main] [--format json|text]',
  );
}

function printResult(result: Result, format: Options['format']) {
  if (format === 'json') console.log(JSON.stringify(result));
  else {
    console.log(
      `Release ${result.status}: PR #${result.pullRequest}, version ${result.version}, ${result.paths.length} coupled files.`,
    );
  }
}

async function gitText(...args: string[]) {
  return (await run(['git', ...args])).trim();
}

async function run(command: string[]) {
  const child = Bun.spawn(command, { stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${command.join(' ')} failed.`);
  }
  return stdout;
}

async function main() {
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  try {
    const result = await prepareReleasePullRequest(options);
    printResult(result, options.format);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.format === 'json') {
      console.log(JSON.stringify({ status: 'refused', errors: [message] }));
    } else {
      console.error(`Release preparation refused:\n- ${message}`);
    }
    process.exit(1);
  }
}

if (import.meta.main) await main();
