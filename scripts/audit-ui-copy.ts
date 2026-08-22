import path from 'node:path';
import { exceedsWarningLimit, findUiCopyWarnings } from './ui-copy-audit/audit';
import { includeWholeFile, parseChangedLines } from './ui-copy-audit/changed-lines';

type Options = {
  all: boolean;
  base: string;
  maxWarnings: number;
  staged: boolean;
};

function parseOptions(arguments_: string[]): Options {
  const argument = arguments_.find((value) => value.startsWith('--max-warnings='));
  const maxWarnings = argument
    ? Number(argument.slice('--max-warnings='.length))
    : Number.POSITIVE_INFINITY;
  if ((!Number.isInteger(maxWarnings) && maxWarnings !== Number.POSITIVE_INFINITY) || maxWarnings < 0) {
    console.error('--max-warnings must be a non-negative integer.');
    process.exit(2);
  }
  const baseArgument = arguments_.find((value) => value.startsWith('--base='));
  return {
    all: arguments_.includes('--all'),
    base: baseArgument?.slice('--base='.length) || process.env.UI_COPY_BASE || 'origin/main',
    maxWarnings,
    staged: arguments_.includes('--staged'),
  };
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const options = parseOptions(process.argv.slice(2));
const allWarnings = findUiCopyWarnings(repoRoot);
const warnings = options.all ? allWarnings : changedWarnings(allWarnings, options);

for (const warning of warnings) {
  const location = `${warning.filePath}:${warning.line}:${warning.column}`;
  const message = warning.code === 'full-caps-copy'
    ? `visible copy ${JSON.stringify(warning.text)} uses full caps; use sentence case`
    : 'text styling forces full caps; remove the uppercase transform';
  console.warn(`warning[${warning.code}]: ${location} ${message}`);
}

console.log(`UI copy lint completed with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}.`);

if (exceedsWarningLimit(warnings.length, options.maxWarnings)) {
  console.error(`UI copy lint failed: ${warnings.length} warnings exceed the allowed ${options.maxWarnings}.`);
  process.exit(1);
}

function changedWarnings(
  warnings: ReturnType<typeof findUiCopyWarnings>,
  options: Pick<Options, 'base' | 'staged'>,
) {
  const diffCommand = options.staged
    ? ['git', 'diff', '--cached', '--unified=0', '--no-ext-diff', '--no-color']
    : ['git', 'diff', '--unified=0', '--no-ext-diff', '--no-color', options.base];
  const diff = Bun.spawnSync(diffCommand, { cwd: repoRoot, stderr: 'pipe', stdout: 'pipe' });
  if (diff.exitCode !== 0) {
    throw new Error(diff.stderr.toString().trim() || `Could not compare UI copy with ${options.base}.`);
  }
  const changedLines = parseChangedLines(diff.stdout.toString());
  if (!options.staged) {
    const untracked = Bun.spawnSync(
      ['git', 'ls-files', '--others', '--exclude-standard', '--', '*.ts', '*.tsx', '*.js', '*.jsx'],
      { cwd: repoRoot, stderr: 'pipe', stdout: 'pipe' },
    );
    if (untracked.exitCode !== 0) throw new Error(untracked.stderr.toString().trim());
    for (const filePath of untracked.stdout.toString().split('\n').filter(Boolean)) {
      includeWholeFile(changedLines, filePath);
    }
  }
  return warnings.filter((warning) => {
    const lines = changedLines.get(warning.filePath);
    return lines === 'all' || Boolean(lines?.has(warning.line));
  });
}
