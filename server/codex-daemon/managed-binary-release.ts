import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, constants, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const maximumManagedCodexBytes = 512 * 1024 * 1024;

function pathWithin(root: string, path: string) {
  const child = relative(root, path);
  return child === '' || (
    !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)
  );
}

async function optionalLstat(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
}

async function syncPath(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function assertSafeManagedCodexDirectory(status: Stats, description: string) {
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o022) !== 0) {
    throw new Error(`${description} is not a secure directory.`);
  }
}

function assertSafeManagedCodexBinary(status: Stats, description: string) {
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 ||
      status.size > maximumManagedCodexBytes || (status.mode & 0o111) === 0 ||
      (status.mode & 0o022) !== 0) {
    throw new Error(`${description} is not a secure executable.`);
  }
}

async function sha256(path: string) {
  return new Promise<string>((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveDigest(hash.digest('hex')));
  });
}

export async function inspectSafeManagedCodexBinaryAt(path: string, boundary: string) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    const target = await readlink(path);
    if (isAbsolute(target)) {
      throw new Error('The managed Codex binary link must be relative.');
    }
    const requested = resolve(dirname(path), target);
    if (!pathWithin(boundary, requested)) {
      throw new Error('The managed Codex binary link escapes its release.');
    }
  } else if (!entry.isFile()) {
    throw new Error('The managed Codex binary entry is invalid.');
  }
  const resolved = await realpath(path);
  if (!pathWithin(boundary, resolved)) {
    throw new Error('The managed Codex binary escapes its release.');
  }
  const status = await lstat(resolved);
  assertSafeManagedCodexBinary(status, 'The managed Codex binary');
  return { digest: await sha256(resolved), path: resolved };
}

async function readReleaseMetadata(path: string, maximumBytes: number) {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || status.size < 1 ||
      status.size > maximumBytes || (status.mode & 0o022) !== 0) {
    throw new Error('The immutable managed Codex release metadata is unsafe.');
  }
  return readFile(path, 'utf8');
}

async function validateImmutableRelease(
  releasePath: string,
  version: string,
  digest: string
) {
  assertSafeManagedCodexDirectory(
    await lstat(releasePath),
    'The immutable managed Codex release'
  );
  const entries = (await readdir(releasePath)).sort();
  if (entries.join('\n') !== ['SHA256', 'VERSION', 'bin', 'codex'].join('\n')) {
    throw new Error('The immutable managed Codex release has an unexpected inventory.');
  }
  const bin = join(releasePath, 'bin');
  assertSafeManagedCodexDirectory(
    await lstat(bin),
    'The immutable managed Codex binary directory'
  );
  if ((await readdir(bin)).join('\n') !== 'codex') {
    throw new Error('The immutable managed Codex binary directory has an unexpected inventory.');
  }
  const link = join(releasePath, 'codex');
  const linkStatus = await lstat(link);
  if (!linkStatus.isSymbolicLink() || await readlink(link) !== 'bin/codex') {
    throw new Error('The immutable managed Codex release has an invalid binary pointer.');
  }
  if (await readReleaseMetadata(join(releasePath, 'VERSION'), 128) !== `${version}\n` ||
      await readReleaseMetadata(join(releasePath, 'SHA256'), 128) !== `${digest}\n`) {
    throw new Error('The immutable managed Codex release metadata does not match.');
  }
  const binary = await inspectSafeManagedCodexBinaryAt(link, releasePath);
  if (binary.digest !== digest) {
    throw new Error('The immutable managed Codex release bytes do not match.');
  }
  return binary.path;
}

export async function createImmutableManagedCodexRelease(
  paths: { releases: string },
  sourcePath: string,
  version: string,
  digest: string
) {
  const releaseName = `${version}-project-space-${digest}`;
  const releasePath = join(paths.releases, releaseName);
  if (await optionalLstat(releasePath)) {
    return {
      binaryPath: await validateImmutableRelease(releasePath, version, digest),
      releaseName,
      releasePath
    };
  }
  const temporary = join(
    paths.releases,
    `.project-space-release-${digest}-${randomBytes(8).toString('hex')}.tmp`
  );
  try {
    await mkdir(temporary, { mode: 0o700 });
    const bin = join(temporary, 'bin');
    await mkdir(bin, { mode: 0o700 });
    const binary = join(bin, 'codex');
    await copyFile(sourcePath, binary, constants.COPYFILE_EXCL);
    await chmod(binary, 0o755);
    if (await sha256(binary) !== digest) {
      throw new Error('The signed Codex binary changed while it was being provisioned.');
    }
    await Promise.all([
      symlink('bin/codex', join(temporary, 'codex')),
      writeFile(join(temporary, 'VERSION'), `${version}\n`, { flag: 'wx', mode: 0o600 }),
      writeFile(join(temporary, 'SHA256'), `${digest}\n`, { flag: 'wx', mode: 0o600 })
    ]);
    await validateImmutableRelease(temporary, version, digest);
    await Promise.all([
      syncPath(binary),
      syncPath(join(temporary, 'VERSION')),
      syncPath(join(temporary, 'SHA256'))
    ]);
    await syncPath(bin);
    await syncPath(temporary);
    if (await optionalLstat(releasePath)) {
      await validateImmutableRelease(releasePath, version, digest);
    } else {
      try {
        await rename(temporary, releasePath);
      } catch (error) {
        if (!await optionalLstat(releasePath)) throw error;
        await validateImmutableRelease(releasePath, version, digest);
      }
      await syncPath(paths.releases);
    }
  } finally {
    await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
  }
  return {
    binaryPath: await validateImmutableRelease(releasePath, version, digest),
    releaseName,
    releasePath
  };
}

export async function inspectManagedCodexSourceDigest(sourcePath: string) {
  if (!isAbsolute(sourcePath)) {
    throw new Error('The signed Codex binary path must be absolute.');
  }
  const before = await lstat(sourcePath);
  assertSafeManagedCodexBinary(before, 'The signed Codex binary');
  const digest = await sha256(sourcePath);
  const after = await lstat(sourcePath);
  assertSafeManagedCodexBinary(after, 'The signed Codex binary');
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.mode !== after.mode) {
    throw new Error('The signed Codex binary changed while it was being inspected.');
  }
  return digest;
}
