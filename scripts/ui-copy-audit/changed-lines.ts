export type ChangedLines = Map<string, Set<number> | 'all'>;

export function parseChangedLines(diff: string): ChangedLines {
  const changedLines: ChangedLines = new Map();
  let currentPath: string | undefined;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim();
      currentPath = path === '/dev/null'
        ? undefined
        : path.replace(/^b\//, '');
      continue;
    }
    if (!currentPath || !line.startsWith('@@ ')) continue;

    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    const lines = changedLines.get(currentPath);
    if (lines === 'all') continue;
    const next = lines ?? new Set<number>();
    for (let offset = 0; offset < count; offset += 1) next.add(start + offset);
    changedLines.set(currentPath, next);
  }

  return changedLines;
}

export function includeWholeFile(changedLines: ChangedLines, filePath: string): void {
  changedLines.set(filePath.replace(/^\.\//, ''), 'all');
}
