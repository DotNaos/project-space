import { useCallback, useEffect, useMemo, useState } from 'react';

import { projectSpaceClient } from '@/api/project-space-client';
import {
  releaseChangelogSchema,
  type ReleaseChangelogEntry,
  type ReleaseChangelogResult
} from '@/shared/release-changelog-api';
import { normalizeStableReleaseVersion } from '@/shared/release-version';
import {
  dismissReleaseChangelogCard,
  releaseChangelogQueryParameter,
  releaseChangelogVersionFromSearch,
  shouldShowReleaseChangelogCard,
  type ReleaseChangelogStorage
} from './release-changelog-state';

function browserLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function useReleaseChangelog({
  currentVersion,
  enabled,
  storage = browserLocalStorage()
}: {
  currentVersion: string;
  enabled: boolean;
  storage?: ReleaseChangelogStorage;
}) {
  const normalizedVersion = normalizeStableReleaseVersion(currentVersion);
  const [result, setResult] = useState<ReleaseChangelogResult>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const [dismissedVersion, setDismissedVersion] = useState<string>();

  useEffect(() => {
    setDismissedVersion(undefined);
  }, [normalizedVersion]);

  useEffect(() => {
    let active = true;
    if (!enabled || !normalizedVersion) {
      setResult(undefined);
      setError('');
      setIsLoading(false);
      return () => {
        active = false;
      };
    }

    setIsLoading(true);
    setError('');
    void projectSpaceClient.getReleaseChangelog().then(
      (nextResult) => {
        if (!active) return;
        if (
          nextResult.schema !== releaseChangelogSchema ||
          nextResult.currentVersion !== normalizedVersion
        ) {
          throw new Error('Release changelog does not match the running version.');
        }
        setResult(nextResult);
        setIsLoading(false);
      },
      (reason) => {
        if (!active) return;
        setResult(undefined);
        setError(
          reason instanceof Error
            ? reason.message
            : 'Release changelog is temporarily unavailable.'
        );
        setIsLoading(false);
      }
    ).catch((reason) => {
      if (!active) return;
      setResult(undefined);
      setError(reason instanceof Error ? reason.message : 'Release changelog is invalid.');
      setIsLoading(false);
    });

    return () => {
      active = false;
    };
  }, [enabled, normalizedVersion]);

  const currentRelease = useMemo(
    () => result?.releases.find((release) => release.version === normalizedVersion),
    [normalizedVersion, result]
  );
  const selectedRelease = useMemo(
    () => result?.releases.find((release) => release.version === selectedVersion),
    [result, selectedVersion]
  );

  useEffect(() => {
    if (!result) return;
    const linkedVersion = typeof window === 'undefined'
      ? undefined
      : releaseChangelogVersionFromSearch(window.location.search);
    const linkedRelease = result.releases.find(
      (release) => release.version === linkedVersion
    );
    setSelectedVersion(linkedRelease?.version ?? normalizedVersion ?? result.releases[0]?.version);
    if (linkedRelease) setIsDialogOpen(true);
  }, [normalizedVersion, result]);

  const updateQuery = useCallback((version?: string) => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (version) url.searchParams.set(releaseChangelogQueryParameter, version);
    else url.searchParams.delete(releaseChangelogQueryParameter);
    window.history.replaceState(window.history.state, '', url);
  }, []);

  const open = useCallback((version?: string) => {
    const requested = version
      ? result?.releases.find((release) => release.version === version)
      : undefined;
    const nextVersion = requested?.version ?? normalizedVersion ?? result?.releases[0]?.version;
    setSelectedVersion(nextVersion);
    setIsDialogOpen(true);
    updateQuery(nextVersion);
  }, [normalizedVersion, result, updateQuery]);

  const close = useCallback(() => {
    setIsDialogOpen(false);
    updateQuery();
  }, [updateQuery]);

  const select = useCallback((version: string) => {
    const release = result?.releases.find((entry) => entry.version === version);
    if (!release) return;
    setSelectedVersion(release.version);
    updateQuery(release.version);
  }, [result, updateQuery]);

  const dismissCurrent = useCallback(() => {
    if (!normalizedVersion) return;
    dismissReleaseChangelogCard(normalizedVersion, storage);
    setDismissedVersion(normalizedVersion);
  }, [normalizedVersion, storage]);

  return {
    close,
    currentRelease,
    currentVersion: normalizedVersion,
    dismissCurrent,
    error,
    isCardVisible: Boolean(
      enabled &&
        currentRelease &&
        dismissedVersion !== normalizedVersion &&
        normalizedVersion &&
        shouldShowReleaseChangelogCard(normalizedVersion, storage)
    ),
    isDialogOpen,
    isLoading,
    open,
    releases: result?.releases ?? ([] as ReleaseChangelogEntry[]),
    select,
    selectedRelease,
    selectedVersion
  };
}
