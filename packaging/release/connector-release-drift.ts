const sensitiveDirectoryPrefixes = [
  'cmd/',
  'internal/',
  'packaging/',
  'server/',
  'src/shared/'
] as const;

const sensitiveFiles = new Set([
  'bun.lock',
  'go.mod',
  'go.sum',
  'package.json'
]);

export function isConnectorReleaseSensitivePath(path: string) {
  return sensitiveFiles.has(path)
    || sensitiveDirectoryPrefixes.some((prefix) => path.startsWith(prefix))
    || /^tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/.test(path)
    || /^\.github\/workflows\/release(?:-[A-Za-z0-9_-]+)?\.yml$/.test(path);
}

export function connectorReleaseSensitivePaths(paths: readonly string[]) {
  return paths.filter(isConnectorReleaseSensitivePath);
}

async function main() {
  const paths = (await Bun.stdin.text()).split('\0').filter(Boolean);
  const sensitive = connectorReleaseSensitivePaths(paths);
  if (sensitive.length === 0) return;
  console.error(
    'The app commit changes connector release inputs after the approved release:'
  );
  for (const path of sensitive) console.error(`- ${path}`);
  process.exit(1);
}

if (import.meta.main) await main();
