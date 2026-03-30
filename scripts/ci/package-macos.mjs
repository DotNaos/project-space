import { readdir, rename, rm } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { getChannelBuildMeta, normalizeChannel } from '../build/channel-build-meta.mjs';

const rootDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const releaseDirectory = join(rootDirectory, 'release');
const releaseChannel = normalizeChannel(process.env.RELEASE_CHANNEL);
const channelBuildMeta = getChannelBuildMeta(releaseChannel);
const channel = sanitizeLabel(channelBuildMeta.releaseArtifactChannel);
const shortSha = sanitizeLabel((process.env.RELEASE_SHA || process.env.GITHUB_SHA || 'local').slice(0, 7));

await rm(releaseDirectory, { recursive: true, force: true });
await runCommand('bash', [join(rootDirectory, 'scripts', 'build-macos-icon.sh')]);
await runCommand('pnpm', [
  'exec',
  'electron-builder',
  '--config',
  'electron-builder.config.mjs',
  '--mac',
  'dmg',
  'zip',
  '--publish',
  'never'
]);

const releaseEntries = await readdir(releaseDirectory, { withFileTypes: true });
const packageFiles = releaseEntries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => ['.dmg', '.zip'].includes(extname(name)))
  .sort();

if (packageFiles.length === 0) {
  throw new Error('No macOS package files were generated in release/.');
}

for (const fileName of packageFiles) {
  const extension = extname(fileName);
  const targetName = `project-space-${channel}-${shortSha}-macos${extension}`;

  if (fileName === targetName) {
    continue;
  }

  await rename(join(releaseDirectory, fileName), join(releaseDirectory, targetName));
}

console.log(
  `Prepared macOS release assets for channel "${channel}" (${shortSha}) in ${releaseDirectory}.`
);

function sanitizeLabel(value) {
  return value.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDirectory,
      env: process.env,
      stdio: 'inherit'
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}.`));
    });

    child.on('error', reject);
  });
}
