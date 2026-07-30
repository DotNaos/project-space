import type { ReleaseBump } from './types';

const stableSemverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface StableSemver {
  major: number;
  minor: number;
  patch: number;
}

export function parseStableSemver(
  value: string,
): StableSemver | undefined {
  const match = stableSemverPattern.exec(value);
  if (!match) return undefined;

  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  return Object.values(parsed).every(Number.isSafeInteger)
    ? parsed
    : undefined;
}

export function compareStableSemver(left: string, right: string) {
  const parsedLeft = parseStableSemver(left);
  const parsedRight = parseStableSemver(right);
  if (!parsedLeft || !parsedRight) {
    throw new Error(
      `Cannot compare invalid stable versions "${left}" and "${right}".`,
    );
  }

  return (
    parsedLeft.major - parsedRight.major ||
    parsedLeft.minor - parsedRight.minor ||
    parsedLeft.patch - parsedRight.patch
  );
}

export function expectedVersionForBump(
  current: string,
  bump: ReleaseBump,
) {
  const parsed = parseStableSemver(current);
  if (!parsed) {
    throw new Error(
      `Current main version "${current}" is not stable SemVer.`,
    );
  }

  if (bump === 'major') {
    return `${parsed.major + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function releaseMinor(version: string) {
  const parsed = parseStableSemver(version);
  if (!parsed) {
    throw new Error(`Version "${version}" is not stable SemVer.`);
  }
  return `v${parsed.major}.${parsed.minor}`;
}

export function releaseMajor(version: string) {
  const parsed = parseStableSemver(version);
  if (!parsed) {
    throw new Error(`Version "${version}" is not stable SemVer.`);
  }
  return `v${parsed.major}`;
}

export function releaseAnchor(version: string) {
  const parsed = parseStableSemver(version);
  if (!parsed) {
    throw new Error(`Version "${version}" is not stable SemVer.`);
  }
  return `v${parsed.major}-${parsed.minor}-${parsed.patch}`;
}
