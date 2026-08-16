const authTokenStorageKey = 'project-space.session-token';

let projectSpaceAuthToken = '';
let projectSpaceAuthTokenProvider: ((options?: { skipCache?: boolean }) => Promise<string | null>) | null = null;
let projectSpaceAuthTokenProviderGeneration = 0;
let projectSpaceAuthTokenRefresh: {
  generation: number;
  promise: Promise<string>;
} | undefined;

export function getProjectSpaceAuthToken() {
  return projectSpaceAuthToken;
}

export function setProjectSpaceAuthTokenProvider(
  provider: ((options?: { skipCache?: boolean }) => Promise<string | null>) | null
) {
  projectSpaceAuthTokenProvider = provider;
  projectSpaceAuthTokenProviderGeneration += 1;
  projectSpaceAuthTokenRefresh = undefined;
  projectSpaceAuthToken = '';
}

export function setProjectSpaceAuthToken(token: string) {
  projectSpaceAuthToken = token;

  if (typeof window === 'undefined') {
    return;
  }

  if (token) {
    window.localStorage.setItem(authTokenStorageKey, token);
    return;
  }

  window.localStorage.removeItem(authTokenStorageKey);
}

export async function refreshProjectSpaceAuthToken(options: { skipCache?: boolean } = {}): Promise<string> {
  const provider = projectSpaceAuthTokenProvider;
  if (!provider) {
    return projectSpaceAuthToken;
  }

  const generation = projectSpaceAuthTokenProviderGeneration;
  const refresh = !options.skipCache && projectSpaceAuthTokenRefresh?.generation === generation
    ? projectSpaceAuthTokenRefresh
    : {
        generation,
        promise: provider(options).then((token) => token ?? '')
      };
  projectSpaceAuthTokenRefresh = refresh;

  try {
    const token = await refresh.promise;
    if (
      projectSpaceAuthTokenProviderGeneration === generation
      && projectSpaceAuthTokenProvider === provider
    ) {
      projectSpaceAuthToken = token;
      return token;
    }
    return refreshProjectSpaceAuthToken();
  } finally {
    if (projectSpaceAuthTokenRefresh === refresh) {
      projectSpaceAuthTokenRefresh = undefined;
    }
  }
}
