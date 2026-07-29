export interface NativeReviewConfig {
  origin: string;
  pullRequestNumber: number;
}

export function nativeReviewConfig(
  environment: Record<string, string | undefined> = process.env
): NativeReviewConfig | undefined {
  const rawOrigin = environment.EXPO_PUBLIC_PROJECT_SPACE_REVIEW_ORIGIN?.trim();
  const pullRequestNumber = Number(
    environment.EXPO_PUBLIC_PROJECT_SPACE_REVIEW_PR
  );
  if (
    !rawOrigin ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber < 1
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    return undefined;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !isLocalOrTailscaleHost(url.hostname))
  ) {
    return undefined;
  }
  return {
    origin: url.origin,
    pullRequestNumber,
  };
}

function isLocalOrTailscaleHost(hostname: string) {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.ts.net')
  ) {
    return true;
  }
  const parts = host.split('.').map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 &&
    parts[1]! >= 64 &&
    parts[1]! <= 127
  );
}
