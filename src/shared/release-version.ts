export function normalizeStableReleaseVersion(value: string) {
  const normalized = value.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : undefined;
}

export function compareStableReleaseVersions(left: string, right: string) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
