import { createClerkClient } from '@clerk/backend';

import { readGitHubOAuthToken } from '../local-database-store';
import { normalizeProjectChatProviderAvatarUrl } from './avatar';

const defaultCacheTtlMs = 5 * 60_000;
const maximumCachedProfiles = 512;
const unsafeProfileText = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

export interface ProjectChatAccountProfile {
  avatarUrl?: string;
  defaultsResolved: boolean;
  displayName?: string;
}

type ProviderProfile = Omit<ProjectChatAccountProfile, 'defaultsResolved'>;

interface ClerkProfile {
  emailAddresses?: Array<{ emailAddress?: string }>;
  firstName?: string | null;
  imageUrl?: string;
  lastName?: string | null;
  primaryEmailAddress?: { emailAddress?: string } | null;
  username?: string | null;
}

interface GitHubProfile {
  avatar_url?: unknown;
  login?: unknown;
  name?: unknown;
}

interface GitHubToken {
  accessToken: string;
}

export interface ProjectChatAccountProfileReaderOptions {
  cacheTtlMs?: number;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  readClerkProfile?(userId: string): Promise<ClerkProfile | null>;
  readGitHubToken?(userId: string): Promise<GitHubToken | null>;
}

export function createProjectChatAccountProfileReader(
  options: ProjectChatAccountProfileReaderOptions = {}
) {
  const cacheTtlMs = options.cacheTtlMs ?? defaultCacheTtlMs;
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0) {
    throw new TypeError('Project Chat account profile cache TTL must be non-negative.');
  }
  const now = options.now ?? Date.now;
  const readClerkProfile = options.readClerkProfile ?? defaultClerkProfileReader;
  const readGitHubToken = options.readGitHubToken ?? readGitHubOAuthToken;
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const cache = new Map<string, { expiresAt: number; profile: ProjectChatAccountProfile }>();

  return async function readProjectChatAccountProfile(userId: string) {
    const cached = cache.get(userId);
    if (cached && cached.expiresAt > now()) {
      return structuredClone(cached.profile);
    }

    let clerk: ClerkProfile | null = null;
    let clerkResolved = false;
    try {
      clerk = await readClerkProfile(userId);
      clerkResolved = clerk !== null;
    } catch {
      // A provider outage must not replace previously persisted account defaults.
    }
    const clerkProfile = profileFromClerk(clerk);
    let githubProfile: ProviderProfile = {};
    let defaultsResolved = clerkResolved;
    if (!clerkProfile.avatarUrl || !clerkProfile.displayName) {
      let token: GitHubToken | null = null;
      let tokenResolved = false;
      try {
        token = await readGitHubToken(userId);
        tokenResolved = true;
      } catch {
        // Preserve the existing defaults when the fallback source is unavailable.
      }
      if (!tokenResolved) {
        defaultsResolved = false;
      } else if (!token) {
        defaultsResolved = clerkResolved;
      } else {
        const github = await readGitHubProfile(fetchImplementation, token.accessToken);
        githubProfile = github.profile;
        defaultsResolved = github.resolved;
      }
    }

    const profile = {
      avatarUrl: clerkProfile.avatarUrl ?? githubProfile.avatarUrl,
      defaultsResolved,
      displayName: clerkProfile.displayName ?? githubProfile.displayName
    } satisfies ProjectChatAccountProfile;
    evictExpiredOrOldest(cache, now());
    cache.set(userId, { expiresAt: now() + cacheTtlMs, profile });
    return structuredClone(profile);
  };
}

async function defaultClerkProfileReader(userId: string): Promise<ClerkProfile | null> {
  const secretKey = process.env.CLERK_SECRET_KEY ?? '';
  if (!secretKey) {
    return null;
  }
  return createClerkClient({ secretKey }).users.getUser(userId);
}

function profileFromClerk(profile: ClerkProfile | null): ProviderProfile {
  if (!profile) {
    return {};
  }
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  const email = profile.primaryEmailAddress?.emailAddress
    ?? profile.emailAddresses?.[0]?.emailAddress;
  return {
    avatarUrl: normalizeProjectChatProviderAvatarUrl(profile.imageUrl),
    displayName:
      safeProviderDisplayName(fullName)
      ?? safeProviderDisplayName(profile.username)
      ?? safeProviderDisplayName(email?.split('@', 1)[0])
  };
}

async function readGitHubProfile(
  fetchImplementation: typeof fetch,
  token: string
): Promise<{ profile: ProviderProfile; resolved: boolean }> {
  if (!token || token.length > 4_096 || /[\s\u0000-\u001f]/u.test(token)) {
    return { profile: {}, resolved: false };
  }
  try {
    const response = await fetchImplementation('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'project-space'
      },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      return { profile: {}, resolved: false };
    }
    const profile = await response.json() as GitHubProfile;
    return {
      profile: {
        avatarUrl: typeof profile.avatar_url === 'string'
          ? normalizeProjectChatProviderAvatarUrl(profile.avatar_url)
          : undefined,
        displayName:
          safeProviderDisplayName(profile.name)
          ?? safeProviderDisplayName(profile.login)
      },
      resolved: true
    };
  } catch {
    return { profile: {}, resolved: false };
  }
}

function evictExpiredOrOldest(
  cache: Map<string, { expiresAt: number; profile: ProjectChatAccountProfile }>,
  now: number
) {
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) {
      cache.delete(key);
    }
  }
  while (cache.size >= maximumCachedProfiles) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.delete(oldest);
  }
}

function safeProviderDisplayName(value: unknown) {
  if (typeof value !== 'string' || unsafeProfileText.test(value)) {
    return undefined;
  }
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized && normalized.length <= 48 ? normalized : undefined;
}

export const readProjectChatAccountProfile = createProjectChatAccountProfileReader();
