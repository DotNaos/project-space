const maximumReturnLength = 4_096;

export function exactPrototypeReviewReturn(currentHref: string) {
  try {
    const current = new URL(currentHref);
    if (
      !['http:', 'https:'].includes(current.protocol) ||
      current.username ||
      current.password ||
      (
        current.pathname !== '/prototype-review' &&
        !current.pathname.startsWith('/prototype-review/')
      )
    ) {
      return '/';
    }
    const result = `${current.pathname}${current.search}${current.hash}`;
    return result.length <= maximumReturnLength ? result : '/';
  } catch {
    return '/';
  }
}
