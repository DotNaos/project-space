#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';

const semanticVersionPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const buildIdPattern = /^[0-9a-f]{40}$/;
const targets = new Set([
  'bun',
  'bun-darwin-arm64',
  'bun-linux-x64',
  'bun-windows-x64'
]);

export interface CodexHostBuildIdentity {
  buildId: string;
  releaseId: string;
  version: string;
}

export function codexHostBuildArguments(
  target: string,
  output: string,
  identity: CodexHostBuildIdentity
) {
  if (!targets.has(target) || !output.trim()) {
    throw new Error('Codex host build target or output path is invalid.');
  }
  if (!semanticVersionPattern.test(identity.version) ||
      identity.releaseId !== `v${identity.version}` ||
      !buildIdPattern.test(identity.buildId)) {
    throw new Error('Codex host build identity must be an exact release and full commit SHA.');
  }
  const define = (name: string, value: string) => [
    '--define', `${name}=${JSON.stringify(value)}`
  ];
  return [
    'build',
    '--compile',
    `--target=${target}`,
    '--no-compile-autoload-dotenv',
    'server/workspace-runtime-codex-host/cli.ts',
    '--outfile',
    output,
    ...define('__PROJECT_SPACE_VERSION__', identity.version),
    ...define('__PROJECT_SPACE_RELEASE_ID__', identity.releaseId),
    ...define('__PROJECT_SPACE_BUILD_ID__', identity.buildId)
  ];
}

async function packageVersion() {
  const value: unknown = JSON.parse(await readFile('package.json', 'utf8'));
  const version = value && typeof value === 'object' && 'version' in value
    ? String(value.version)
    : '';
  if (!semanticVersionPattern.test(version)) {
    throw new Error('package.json contains an invalid release version.');
  }
  return version;
}

async function currentBuildId(environment: NodeJS.ProcessEnv) {
  const configured = environment.PROJECT_RELEASE_SOURCE_SHA?.trim() ||
    environment.GITHUB_SHA?.trim() ||
    environment.PROJECT_SPACE_BUILD_ID?.trim();
  if (configured) return configured;
  const command = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
    stderr: 'pipe',
    stdout: 'pipe'
  });
  const buildId = (await new Response(command.stdout).text()).trim();
  if (await command.exited !== 0) {
    throw new Error('Could not resolve the Codex host build commit.');
  }
  return buildId;
}

export async function codexHostBuildIdentity(
  environment: NodeJS.ProcessEnv = process.env
): Promise<CodexHostBuildIdentity> {
  const version = environment.VERSION?.trim() || await packageVersion();
  const identity = {
    buildId: await currentBuildId(environment),
    releaseId: environment.RELEASE_ID?.trim() || `v${version}`,
    version
  };
  if (!semanticVersionPattern.test(identity.version) ||
      identity.releaseId !== `v${identity.version}` ||
      !buildIdPattern.test(identity.buildId)) {
    throw new Error('Codex host build identity must be an exact release and full commit SHA.');
  }
  return identity;
}

async function main() {
  const [target, output, ...extra] = process.argv.slice(2);
  if (!target || !output || extra.length > 0) {
    throw new Error('Usage: build-codex-host.ts <bun-target> <output-path>');
  }
  const arguments_ = codexHostBuildArguments(
    target,
    output,
    await codexHostBuildIdentity()
  );
  const build = Bun.spawn([process.execPath, ...arguments_], {
    stderr: 'inherit',
    stdout: 'inherit'
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

if (import.meta.main) {
  await main();
}
