import { useEffect, useMemo, useState } from 'react';
import { Github, RefreshCw } from 'lucide-react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  GitHubCatalogRepository,
  GitHubCatalogResult,
  GitHubOAuthDeviceStartResult,
  GitHubProjectConfigStatus
} from '@/shared/project-space-api';

const emptyCatalog: GitHubCatalogResult = {
  checkedAt: '',
  repositories: [],
  status: 'auth-required'
};

function configChipClass(status: GitHubProjectConfigStatus) {
  if (status === 'complete') {
    return 'text-emerald-300';
  }

  if (status === 'partial') {
    return 'text-amber-300';
  }

  if (status === 'unknown') {
    return 'text-neutral-300';
  }

  return 'text-neutral-500';
}

function summarizeConfig(repositories: GitHubCatalogRepository[]) {
  return repositories.reduce<Record<GitHubProjectConfigStatus, number>>(
    (totals, repo) => {
      totals[repo.projectConfig.status] += 1;
      return totals;
    },
    {
      complete: 0,
      partial: 0,
      missing: 0,
      unknown: 0
    }
  );
}

function GitHubAuthPanel({
  catalog,
  flow,
  isBusy,
  onConnect,
  onPoll
}: {
  catalog: GitHubCatalogResult;
  flow?: GitHubOAuthDeviceStartResult;
  isBusy: boolean;
  onConnect(): void;
  onPoll(): void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-800 bg-neutral-950/30 px-4 py-3">
      <Text className="block text-sm font-medium text-neutral-200">
        {catalog.status === 'not-configured' ? 'OAuth not configured' : 'Connect GitHub'}
      </Text>
      <Text className="mt-1 block text-sm text-neutral-500">
        {catalog.message ?? 'Connect a GitHub account to load remote repositories.'}
      </Text>

      {flow?.status === 'pending' ? (
        <div className="mt-4 grid gap-3">
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 px-3 py-2">
            <Text className="block text-xs uppercase tracking-[0.16em] text-neutral-500">
              GitHub code
            </Text>
            <Text className="mt-1 block font-mono text-lg font-semibold text-neutral-50">
              {flow.userCode}
            </Text>
          </div>
          <div className="flex flex-wrap gap-2">
            {flow.verificationUri ? (
              <a href={flow.verificationUri} target="_blank" rel="noreferrer">
                <Button size="sm" variant="outline">
                  Open GitHub
                </Button>
              </a>
            ) : null}
            <Button size="sm" variant="secondary" isDisabled={isBusy} onPress={onPoll}>
              Check login
            </Button>
          </div>
        </div>
      ) : (
        <Button
          className="mt-3"
          size="sm"
          variant="outline"
          isDisabled={isBusy || catalog.status === 'not-configured'}
          onPress={onConnect}
        >
          <Github className="size-4" />
          Connect GitHub
        </Button>
      )}
    </div>
  );
}

export function GitHubCatalogPanel() {
  const [catalog, setCatalog] = useState<GitHubCatalogResult>(emptyCatalog);
  const [flow, setFlow] = useState<GitHubOAuthDeviceStartResult>();
  const [isBusy, setIsBusy] = useState(false);
  const configSummary = useMemo(
    () => summarizeConfig(catalog.repositories),
    [catalog.repositories]
  );

  async function refresh() {
    setIsBusy(true);
    try {
      setCatalog(await projectSpaceClient.getGitHubCatalog());
    } finally {
      setIsBusy(false);
    }
  }

  async function connect() {
    setIsBusy(true);
    try {
      setFlow(await projectSpaceClient.startGitHubOAuthDeviceFlow());
    } finally {
      setIsBusy(false);
    }
  }

  async function poll() {
    if (!flow?.deviceCode) {
      return;
    }

    setIsBusy(true);
    try {
      const result = await projectSpaceClient.pollGitHubOAuthDeviceFlow({
        deviceCode: flow.deviceCode
      });

      if (result.catalog) {
        setCatalog(result.catalog);
      }

      if (result.status !== 'pending') {
        setFlow(undefined);
      }
    } finally {
      setIsBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (catalog.status !== 'connected') {
    return (
      <GitHubAuthPanel
        catalog={catalog}
        flow={flow}
        isBusy={isBusy}
        onConnect={() => void connect()}
        onPoll={() => void poll()}
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <Text className="block truncate text-sm font-semibold text-neutral-100">
            {catalog.auth?.login ? `@${catalog.auth.login}` : 'GitHub'}
          </Text>
          <Text className="block truncate text-xs text-neutral-500">
            {catalog.auth?.source ?? 'connected'} / {catalog.repositories.length} repositories
          </Text>
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1">
          <Chip size="sm" className="text-emerald-300">
            {configSummary.complete} complete
          </Chip>
          {configSummary.partial > 0 ? (
            <Chip size="sm" className="text-amber-300">
              {configSummary.partial} partial
            </Chip>
          ) : null}
          <Chip size="sm" className={configChipClass('missing')}>
            {configSummary.missing} missing
          </Chip>
        </div>
      </div>

      <Button size="sm" variant="ghost" isDisabled={isBusy} onPress={() => void refresh()}>
        <RefreshCw className={isBusy ? 'size-4 animate-spin' : 'size-4'} />
      </Button>
    </div>
  );
}
