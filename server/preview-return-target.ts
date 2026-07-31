import { derivePreviewOrigin } from './preview-gateway-policy';

export function sanitizePreviewReturnTarget(
  value: unknown,
  pullRequestNumber: number
): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048 || !value.startsWith('/') || value.startsWith('//') || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const parsed = new URL(value, derivePreviewOrigin(pullRequestNumber));
    if (parsed.origin !== derivePreviewOrigin(pullRequestNumber) || parsed.username || parsed.password || parsed.hash) return undefined;
    return `${parsed.pathname || '/'}${parsed.search}`;
  } catch {
    return undefined;
  }
}

export function previewHubReturnUrl(
  value: unknown,
  pullRequestNumber: number,
  hubOrigin = 'https://pr.projects.os-home.net'
) {
  const target = sanitizePreviewReturnTarget(value, pullRequestNumber);
  const url = new URL('/', hubOrigin);
  url.searchParams.set('pr', String(pullRequestNumber));
  if (target) url.searchParams.set('return', target);
  return url.toString();
}
