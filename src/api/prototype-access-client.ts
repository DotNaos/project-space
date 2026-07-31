import { refreshProjectSpaceAuthToken } from './project-space-client-auth';

const projectPreviewHost = /^pr-([1-9][0-9]*)\.projects\.os-home\.net$/;

export function prototypeAccessEndpoint(targetUrl: string, pullRequestNumber: number) {
  try {
    const target = new URL(targetUrl);
    const match = projectPreviewHost.exec(target.hostname.toLowerCase());
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      !match ||
      Number(match[1]) !== pullRequestNumber ||
      !(
        target.pathname === '/prototype/desktop' ||
        target.pathname.startsWith('/prototype/desktop/') ||
        target.pathname === '/prototype/mobile' ||
        target.pathname.startsWith('/prototype/mobile/')
      )
    ) {
      return undefined;
    }
    return `${target.origin}/api/pull-request-previews/prototype-access`;
  } catch {
    return undefined;
  }
}

export function prototypeAccessTargetUrl(targetUrl: string, changeId: string) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) return undefined;
  try {
    const target = new URL(targetUrl);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
      return undefined;
    }
    target.searchParams.set('change', changeId);
    return target.toString();
  } catch {
    return undefined;
  }
}

export async function establishPrototypeAccess(
  targetUrl: string,
  pullRequestNumber: number,
  changeId: string,
  surface: 'desktop-prototype' | 'mobile-prototype'
) {
  const endpointValue = prototypeAccessEndpoint(targetUrl, pullRequestNumber);
  if (!endpointValue || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) {
    throw new Error('Project Space refused an untrusted prototype identity.');
  }
  const endpoint = new URL(endpointValue);
  endpoint.searchParams.set('change', changeId);
  endpoint.searchParams.set('surface', surface);
  const token = await refreshProjectSpaceAuthToken();
  if (!token) throw new Error('Sign in before opening this prototype.');
  const response = await fetch(endpoint, {
    credentials: 'include',
    headers: { Authorization: `Bearer ${token}` },
    method: 'POST',
    redirect: 'error'
  });
  if (!response.ok) throw new Error('Project Space could not authorize this prototype.');
}
