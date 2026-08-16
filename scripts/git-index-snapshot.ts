import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function gitCheckoutIndexPrefix(root: string) {
  return `${root.replaceAll('\\', '/').replace(/\/$/, '')}/`;
}

export function materializeGitIndexSnapshot(
  label: string,
  repositoryRoot = process.cwd(),
) {
  const root = mkdtempSync(join(tmpdir(), label));
  const checkout = Bun.spawnSync(
    ['git', 'checkout-index', '--all', `--prefix=${gitCheckoutIndexPrefix(root)}`],
    { cwd: repositoryRoot, stderr: 'pipe', stdout: 'pipe' },
  );
  if (checkout.exitCode !== 0) {
    rmSync(root, { force: true, recursive: true });
    throw new Error(
      checkout.stderr.toString().trim() || 'Unable to materialize the staged Git index.',
    );
  }
  return root;
}
