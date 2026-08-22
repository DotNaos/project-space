export function clerkOAuthRedirectUrls(location: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>) {
  const returnPath = `${location.pathname}${location.search}${location.hash}`;
  return {
    callbackUrl: new URL('/sso-callback', location.origin).toString(),
    completeUrl: new URL(returnPath, location.origin).toString()
  };
}
