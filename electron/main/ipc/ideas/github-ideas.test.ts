import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGhExecutablePath } from './github-ideas';

test('resolveGhExecutablePath prefers a known installed macOS path', async () => {
  const resolvedPath = await resolveGhExecutablePath({
    fileExists: (candidate) => candidate === '/opt/homebrew/bin/gh'
  });

  assert.equal(resolvedPath, '/opt/homebrew/bin/gh');
});

test('resolveGhExecutablePath falls back to the user shell when needed', async () => {
  const resolvedPath = await resolveGhExecutablePath({
    commandRunner: async () => ({ stdout: '/Users/test/.local/bin/gh\n', stderr: '' }),
    fileExists: () => false
  });

  assert.equal(resolvedPath, '/Users/test/.local/bin/gh');
});

test('resolveGhExecutablePath returns an empty string when gh cannot be found', async () => {
  const resolvedPath = await resolveGhExecutablePath({
    commandRunner: async () => {
      throw new Error('missing');
    },
    fileExists: () => false
  });

  assert.equal(resolvedPath, '');
});
