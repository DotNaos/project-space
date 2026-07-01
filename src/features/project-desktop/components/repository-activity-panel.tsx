import { useEffect, useState } from 'react';
import type {
  GitHubCatalogRepository,
  GitHubRepositoryDetailsResult
} from '@/shared/project-space-api';
import { projectSpaceClient } from '@/api/project-space-client';
import { Chip, Surface, Text } from '@/app/dotnaos-ui';
import { GitBranch, ListChecks } from 'lucide-react';
import { repositoryDetailsFallback } from './project-main-model';

export function RepositoryActivityPanel({
  repository
}: {
  repository?: GitHubCatalogRepository;
}) {
  const [details, setDetails] = useState<GitHubRepositoryDetailsResult>();
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!repository) {
      setDetails(undefined);
      return;
    }

    let canceled = false;

    setError('');
    setIsLoading(true);
    projectSpaceClient
      .getGitHubRepositoryDetails(repository.fullName)
      .then((nextDetails) => {
        if (!canceled) {
          setDetails(nextDetails);
        }
      })
      .catch((requestError) => {
        if (!canceled) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : 'Could not load repository details.'
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
  }, [repository]);

  if (!repository) {
    return null;
  }

  const safeDetails = details ?? repositoryDetailsFallback('connected');
  const issuesMessage =
    error || safeDetails.message || (isLoading ? 'Loading repository details...' : '');

  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <Surface
        variant="tertiary"
        className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitBranch className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Branches</Text>
          </div>
          <Text className="text-xs text-neutral-500">{safeDetails.branches.length}</Text>
        </div>
        {safeDetails.branches.length > 0 ? (
          <div className="flex max-h-64 flex-col overflow-auto">
            {safeDetails.branches.map((branch) => (
              <a
                key={branch.name}
                href={branch.url ?? repository.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-neutral-900/60"
              >
                <Text className="truncate text-neutral-200">{branch.name}</Text>
                {branch.isDefault ? (
                  <Chip size="sm" className="text-neutral-100">
                    base
                  </Chip>
                ) : null}
              </a>
            ))}
          </div>
        ) : (
          <Text className="text-sm text-neutral-500">
            {issuesMessage || 'No branches loaded yet.'}
          </Text>
        )}
      </Surface>

      <Surface
        variant="tertiary"
        className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 text-neutral-400" />
            <Text className="text-sm font-semibold text-neutral-100">Issues</Text>
          </div>
          <Text className="text-xs text-neutral-500">{safeDetails.issues.length}</Text>
        </div>
        {safeDetails.issues.length > 0 ? (
          <div className="flex max-h-64 flex-col overflow-auto">
            {safeDetails.issues.map((issue) => (
              <a
                key={issue.number}
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-start gap-3 rounded-lg px-2 py-2 transition hover:bg-neutral-900/60"
              >
                <Text className="shrink-0 text-xs text-neutral-500">#{issue.number}</Text>
                <span className="min-w-0 flex-1">
                  <Text className="block truncate text-sm font-medium text-neutral-100">
                    {issue.title}
                  </Text>
                  {issue.author ? (
                    <Text className="block truncate text-xs text-neutral-500">
                      {issue.author}
                    </Text>
                  ) : null}
                </span>
              </a>
            ))}
          </div>
        ) : (
          <Text className="text-sm text-neutral-500">{issuesMessage || 'No open issues.'}</Text>
        )}
      </Surface>
    </section>
  );
}
