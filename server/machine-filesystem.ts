import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, relative, resolve } from 'node:path';
import type {
  FileSystemEntry,
  MachineFileSystemDirectoryResult,
  MachineFileSystemErrorCode,
  MachineFileSystemFileResult
} from '../src/shared/project-space-api';

const maxReadableFileBytes = 256 * 1024;
const maxPreviewLines = 5_000;

function isPathAtOrInside(parentPath: string, childPath: string) {
  const relativePath = relative(resolve(parentPath), resolve(childPath));
  return relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('/'));
}

function fileSystemErrorCode(error: unknown): MachineFileSystemErrorCode {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return 'failed';
  }
  if (error.code === 'OUTSIDE_HOME') {
    return 'outside-home';
  }

  const code = String(error.code);
  if (code === 'EACCES' || code === 'EPERM') {
    return 'permission-denied';
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'not-found';
  }
  return 'failed';
}

function fileSystemErrorMessage(code: MachineFileSystemErrorCode) {
  if (code === 'permission-denied') {
    return 'This location cannot be read with the current permissions.';
  }
  if (code === 'not-found') {
    return 'This location no longer exists.';
  }
  if (code === 'outside-home') {
    return 'Explorer can only open locations inside the home directory.';
  }
  if (code === 'too-large') {
    return 'This file is too large to display safely.';
  }
  if (code === 'unsupported') {
    return 'This file cannot be displayed as text.';
  }
  return 'This location could not be loaded.';
}

async function resolveHomeScopedPath(inputPath: string) {
  const homePath = resolve(homedir());
  const expandedPath = inputPath === '~'
    ? homePath
    : inputPath.startsWith('~/')
      ? resolve(homePath, inputPath.slice(2))
      : resolve(inputPath);

  if (!isPathAtOrInside(homePath, expandedPath)) {
    throw Object.assign(new Error('Path is outside the home directory.'), { code: 'OUTSIDE_HOME' });
  }

  const [resolvedPath, resolvedHome] = await Promise.all([realpath(expandedPath), realpath(homePath)]);
  if (!isPathAtOrInside(resolvedHome, resolvedPath)) {
    throw Object.assign(new Error('Path resolves outside the home directory.'), { code: 'OUTSIDE_HOME' });
  }
  return resolvedPath;
}

export async function readHomeDirectory(path: string): Promise<MachineFileSystemDirectoryResult> {
  try {
    const resolvedPath = await resolveHomeScopedPath(path);
    const before = await lstat(resolvedPath);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      return {
        entries: [],
        errorCode: 'unsupported',
        message: 'Only regular directories can be opened.',
        path: resolvedPath,
        status: 'error'
      };
    }
    const entries = await readdir(resolvedPath, { withFileTypes: true });
    const verifiedPath = await resolveHomeScopedPath(resolvedPath);
    const after = await lstat(verifiedPath);
    if (verifiedPath !== resolvedPath || before.dev !== after.dev || before.ino !== after.ino) {
      throw Object.assign(new Error('Directory changed while it was being read.'), {
        code: 'OUTSIDE_HOME'
      });
    }
    const results = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() || entry.isFile())
        .map(async (entry) => {
          const entryPath = resolve(resolvedPath, entry.name);
          const metadata = await lstat(entryPath).catch(() => undefined);
          return {
            kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
            modifiedAt: metadata?.mtime.toISOString(),
            name: entry.name,
            path: entryPath,
            sizeBytes: entry.isFile() && metadata?.isFile() ? metadata.size : undefined
          } satisfies FileSystemEntry;
        })
    );

    results.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
    return { entries: results, path: resolvedPath, status: 'success' };
  } catch (error) {
    const errorCode = fileSystemErrorCode(error);
    return {
      entries: [],
      errorCode,
      message: fileSystemErrorMessage(errorCode),
      path,
      status: 'error'
    };
  }
}

export async function readHomeFile(path: string): Promise<MachineFileSystemFileResult> {
  const name = basename(path);
  try {
    const resolvedPath = await resolveHomeScopedPath(path);
    const handle = await open(resolvedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        return { errorCode: 'unsupported', message: 'Only regular files can be opened.', name, path: resolvedPath, status: 'error' };
      }
      if (metadata.size > maxReadableFileBytes) {
        return {
          errorCode: 'too-large',
          message: fileSystemErrorMessage('too-large'),
          modifiedAt: metadata.mtime.toISOString(),
          name,
          path: resolvedPath,
          sizeBytes: metadata.size,
          status: 'error'
        };
      }

      const buffer = Buffer.alloc(maxReadableFileBytes + 1);
      let totalBytes = 0;
      while (totalBytes < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          totalBytes,
          buffer.length - totalBytes,
          null
        );
        if (bytesRead === 0) {
          break;
        }
        totalBytes += bytesRead;
      }
      if (totalBytes > maxReadableFileBytes) {
        return {
          errorCode: 'too-large',
          message: fileSystemErrorMessage('too-large'),
          modifiedAt: metadata.mtime.toISOString(),
          name,
          path: resolvedPath,
          sizeBytes: totalBytes,
          status: 'error'
        };
      }
      const bytes = buffer.subarray(0, totalBytes);
      if (bytes.includes(0)) {
        return {
          errorCode: 'unsupported',
          message: fileSystemErrorMessage('unsupported'),
          modifiedAt: metadata.mtime.toISOString(),
          name,
          path: resolvedPath,
          sizeBytes: metadata.size,
          status: 'error'
        };
      }

      let content = '';
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return {
          errorCode: 'unsupported',
          message: fileSystemErrorMessage('unsupported'),
          modifiedAt: metadata.mtime.toISOString(),
          name,
          path: resolvedPath,
          sizeBytes: metadata.size,
          status: 'error'
        };
      }

      const lines = content.split('\n');
      const truncated = lines.length > maxPreviewLines;
      return {
        content: truncated ? lines.slice(0, maxPreviewLines).join('\n') : content,
        modifiedAt: metadata.mtime.toISOString(),
        name,
        path: resolvedPath,
        sizeBytes: metadata.size,
        status: 'success',
        truncated
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const errorCode = fileSystemErrorCode(error);
    return {
      errorCode,
      message: fileSystemErrorMessage(errorCode),
      name,
      path,
      status: 'error'
    };
  }
}
