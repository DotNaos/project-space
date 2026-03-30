import { readdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const releaseDirectory = join(rootDirectory, 'release');

const releaseTag = requiredEnv('RELEASE_TAG');
const releaseName = requiredEnv('RELEASE_NAME');
const releaseTarget = process.env.RELEASE_TARGET_SHA || process.env.GITHUB_SHA || 'HEAD';
const releaseNotes =
  process.env.RELEASE_NOTES ||
  `Automated ${process.env.RELEASE_CHANNEL || 'release'} build for ${releaseTarget.slice(0, 7)}.`;
const prerelease = process.env.RELEASE_PRERELEASE === 'true';
const markLatest = process.env.RELEASE_LATEST === 'true';

const assets = (await readdir(releaseDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => ['.dmg', '.zip'].includes(extname(name)))
  .map((name) => join(releaseDirectory, name));

if (assets.length === 0) {
  throw new Error('No release assets found in release/.');
}

await runCommand('gh', ['release', 'delete', releaseTag, '--cleanup-tag', '--yes'], {
  allowFailure: true
});
await runCommand('git', ['tag', '-f', releaseTag, releaseTarget]);
await runCommand('git', ['push', 'origin', `refs/tags/${releaseTag}`, '--force']);

const createArgs = ['release', 'create', releaseTag, ...assets, '--title', releaseName, '--notes', releaseNotes];

if (prerelease) {
  createArgs.push('--prerelease');
}

if (markLatest) {
  createArgs.push('--latest');
}

await runCommand('gh', createArgs);

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function runCommand(command, args, options = {}) {
  const { allowFailure = false } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDirectory,
      env: process.env,
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      if (code === 0 || allowFailure) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}.`));
    });

    child.on('error', (error) => {
      if (allowFailure) {
        resolve();
        return;
      }

      reject(error);
    });
  });
}
