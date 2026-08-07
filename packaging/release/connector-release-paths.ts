const sensitiveDirectoryPrefixes = [
  'cmd/',
  'internal/',
  'packaging/',
  'server/',
  'src/shared/',
] as const;

const sensitiveFiles = new Set([
  'bun.lock',
  'go.mod',
  'go.sum',
  'package.json',
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
