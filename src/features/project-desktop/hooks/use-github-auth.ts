import { useEffect, useMemo, useState } from 'react';

import type { GitHubAuthStatus } from '@/shared/electron-api';

const emptyStatus: GitHubAuthStatus = {
  authenticated: false,
  configured: false
};

export function useGitHubAuth() {
  const [status, setStatus] = useState<GitHubAuthStatus>(emptyStatus);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function refreshStatus() {
    const nextStatus = await window.projectSpace.loadGithubAuthStatus();
    setStatus(nextStatus);

    return nextStatus;
  }

  useEffect(() => {
    let canceled = false;

    setIsLoading(true);

    void refreshStatus()
      .catch((loadError) => {
        if (!canceled) {
          setError(
            loadError instanceof Error ? loadError.message : 'Could not load GitHub status.'
          );
        }
      })
      .finally(() => {
        if (!canceled) {
          setIsLoading(false);
        }
      });

    return () => {
      canceled = true;
    };
  }, []);

  const stateKey = useMemo(() => {
    return status.authenticated ? `connected:${status.viewer?.login ?? 'github'}` : 'signed-out';
  }, [status.authenticated, status.viewer?.login]);

  return {
    error,
    isAuthenticated: status.authenticated,
    isConfigured: status.configured,
    isLoading,
    isSigningIn,
    isSigningOut,
    stateKey,
    viewer: status.viewer,
    async signIn() {
      setIsSigningIn(true);
      setError('');

      try {
        const nextStatus = await window.projectSpace.startGithubAuth();
        setStatus(nextStatus);
      } catch (signInError) {
        setError(signInError instanceof Error ? signInError.message : 'GitHub login failed.');
        await refreshStatus().catch(() => undefined);
      } finally {
        setIsSigningIn(false);
      }
    },
    async signOut() {
      setIsSigningOut(true);
      setError('');

      try {
        const nextStatus = await window.projectSpace.signOutGithubAuth();
        setStatus(nextStatus);
      } catch (signOutError) {
        setError(signOutError instanceof Error ? signOutError.message : 'GitHub sign-out failed.');
      } finally {
        setIsSigningOut(false);
      }
    }
  };
}
