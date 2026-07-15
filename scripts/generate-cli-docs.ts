import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '..');
const outputs = [
  {
    format: 'json',
    path: resolve(repositoryRoot, 'apps/docs/generated/project-cli.json'),
  },
  {
    format: 'mdx',
    path: resolve(repositoryRoot, 'apps/docs/content/docs/cli/index.mdx'),
  },
] as const;

function generate(format: 'json' | 'mdx'): string {
  const result = Bun.spawnSync(
    ['go', 'run', './cmd/project', '__docs-model', '--format', format],
    { cwd: repositoryRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  }
  return result.stdout.toString();
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, contents, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

const checkOnly = process.argv.slice(2).includes('--check');
let stale = false;

for (const output of outputs) {
  const generated = generate(output.format);
  if (checkOnly) {
    if ((await readExisting(output.path)) !== generated) {
      stale = true;
      console.error(`CLI documentation is stale: ${output.path}`);
    }
    continue;
  }
  await atomicWrite(output.path, generated);
  console.log(`Generated ${output.path}`);
}

if (stale) {
  console.error('Run `bun run docs:cli:generate` and commit the generated files.');
  process.exit(1);
}
