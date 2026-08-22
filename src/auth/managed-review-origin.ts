function isTailscaleIPv4(hostname: string) {
  const parts = hostname.split('.').map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 100 &&
    parts[1]! >= 64 && parts[1]! <= 127;
}

function localReviewOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLocaleLowerCase();
    const isLocalhost = hostname === 'localhost' || hostname.endsWith('.localhost');
    if (
      !isLocalhost ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.pathname !== '/' || url.search || url.hash || url.username || url.password
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function managedReviewRedirectUrl(
  currentValue: string,
  secureContext: boolean,
  configuredLocalReviewUrl: string | undefined
) {
  if (secureContext) return undefined;
  try {
    const current = new URL(currentValue);
    const targetOrigin = localReviewOrigin(configuredLocalReviewUrl);
    if (!targetOrigin || current.protocol !== 'http:' || !isTailscaleIPv4(current.hostname)) {
      return undefined;
    }
    return new URL(`${current.pathname}${current.search}${current.hash}`, targetOrigin).toString();
  } catch {
    return undefined;
  }
}
