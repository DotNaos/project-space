import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Chip,
  Surface,
  Text
} from '@/app/dotnaos-ui';
import {
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  GitBranch,
  History,
  Radio,
  RefreshCw,
  Rocket,
  ServerCog,
  Workflow,
  XCircle
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  DeployCliEnvironmentReport,
  DeployCliStatusReport,
  DeploymentRecordSummary,
  GitHubCatalogRepository,
  GitHubPipelineStatusResult,
  GitHubWorkflowRunSummary,
  PlatformOverviewResult
} from '@/shared/project-space-api';

interface ProjectDeploymentsPanelProps {
  projectName: string;
  repository?: GitHubCatalogRepository;
  targetPath: string;
}

const refreshIntervalMs = 30_000;

type DeploymentTone = 'ok' | 'pending' | 'failed' | 'muted';

interface RuntimeCheck {
  label: string;
  ok: boolean;
}

interface RuntimeEnvironmentStatus {
  checks: RuntimeCheck[];
  report: DeployCliEnvironmentReport;
  serviceLines: string[];
}

interface RuntimeState {
  environments: RuntimeEnvironmentStatus[];
  host?: string;
  message?: string;
  state: 'idle' | 'running' | 'done' | 'unavailable' | 'error';
}

function deploymentMatchesProject(deployment: DeploymentRecordSummary, projectName: string) {
  const expected = projectName.toLowerCase();
  const appSlug = deployment.appSlug.toLowerCase();

  return appSlug === expected || appSlug === `${expected}-beta`;
}

function deploymentUrl(deployment: DeploymentRecordSummary) {
  if (deployment.live?.url) {
    return deployment.live.url;
  }

  if (deployment.routeKind === 'public' && deployment.routeHost) {
    return `https://${deployment.routeHost}`;
  }

  return '';
}

function deploymentTone(status: string): DeploymentTone {
  const normalized = status.toLowerCase();

  if (['deployed', 'running', 'ready', 'success'].includes(normalized)) {
    return 'ok';
  }

  if (['building', 'pending', 'queued', 'planned', 'in_progress'].includes(normalized)) {
    return 'pending';
  }

  if (['failed', 'error', 'canceled', 'cancelled', 'rolled-back'].includes(normalized)) {
    return 'failed';
  }

  return 'muted';
}

const toneChipClass: Record<DeploymentTone, string> = {
  failed: 'border border-red-500/30 bg-red-500/10 text-red-300',
  muted: 'border border-neutral-700 bg-neutral-900 text-neutral-400',
  ok: 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  pending: 'border border-amber-500/30 bg-amber-500/10 text-amber-300'
};

function ToneChip({ label, tone }: { label: string; tone: DeploymentTone }) {
  return (
    <Chip size="sm" className={toneChipClass[tone]}>
      {label}
    </Chip>
  );
}

function formatDate(value?: string) {
  if (!value) {
    return 'unknown';
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

function formatRelativeTime(value?: string) {
  if (!value) {
    return 'unknown';
  }

  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    return 'unknown';
  }

  const deltaSeconds = Math.round((Date.now() - timestamp) / 1000);

  if (deltaSeconds < 45) {
    return 'just now';
  }
  if (deltaSeconds < 3600) {
    return `${Math.max(1, Math.round(deltaSeconds / 60))}m ago`;
  }
  if (deltaSeconds < 86_400) {
    return `${Math.round(deltaSeconds / 3600)}h ago`;
  }

  return `${Math.round(deltaSeconds / 86_400)}d ago`;
}

function formatRunDuration(run: GitHubWorkflowRunSummary) {
  const start = Date.parse(run.runStartedAt ?? run.createdAt ?? '');
  const end = run.status === 'completed' ? Date.parse(run.updatedAt ?? '') : Date.now();

  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return '';
  }

  const seconds = Math.round((end - start) / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function shortRevision(revision?: string) {
  return revision ? revision.slice(0, 7) : '';
}

function liveStatusLabel(deployment: DeploymentRecordSummary) {
  if (!deployment.live || deployment.live.status === 'unknown') {
    return 'not checked';
  }

  if (deployment.live.status === 'online') {
    return deployment.live.statusCode ? `online ${deployment.live.statusCode}` : 'online';
  }

  return deployment.live.statusCode ? `offline ${deployment.live.statusCode}` : 'offline';
}

function runTone(run: GitHubWorkflowRunSummary): DeploymentTone {
  if (run.status !== 'completed') {
    return 'pending';
  }

  if (run.conclusion === 'success') {
    return 'ok';
  }

  if (run.conclusion === 'failure' || run.conclusion === 'timed_out') {
    return 'failed';
  }

  return 'muted';
}

function runLabel(run: GitHubWorkflowRunSummary) {
  return run.status === 'completed' ? (run.conclusion ?? 'completed') : run.status.replace('_', ' ');
}

function RunStatusIcon({ run }: { run: GitHubWorkflowRunSummary }) {
  const tone = runTone(run);

  if (tone === 'pending') {
    return <RefreshCw className="size-4 shrink-0 animate-spin text-amber-300" />;
  }
  if (tone === 'ok') {
    return <CheckCircle2 className="size-4 shrink-0 text-emerald-300" />;
  }
  if (tone === 'failed') {
    return <XCircle className="size-4 shrink-0 text-red-300" />;
  }

  return <CircleDashed className="size-4 shrink-0 text-neutral-500" />;
}

function ExternalLinkRow({ label, url }: { label: string; url?: string }) {
  if (!url) {
    return null;
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="group inline-flex min-w-0 items-center gap-1 text-xs text-neutral-400 transition hover:text-neutral-100"
    >
      <span className="shrink-0 text-neutral-500">{label}</span>
      <span className="min-w-0 truncate underline decoration-neutral-700 underline-offset-2 group-hover:decoration-neutral-200">
        {url.replace(/^https?:\/\//, '')}
      </span>
      <ExternalLink className="size-3 shrink-0 text-neutral-500 group-hover:text-neutral-200" />
    </a>
  );
}

const runtimeCheckMatchers: Array<{ label: string; failed: string; ok: string }> = [
  { failed: 'ssh failed', label: 'SSH', ok: 'ssh ok' },
  { failed: 'docker api unavailable', label: 'Docker', ok: 'docker api ok' },
  { failed: 'traefik missing', label: 'Traefik', ok: 'traefik running' },
  { failed: 'traefik-public network missing', label: 'Ingress network', ok: 'traefik-public network ok' },
  { failed: 'repo missing', label: 'Repo on VPS', ok: 'repo present' }
];

function parseRuntimeEnvironment(report: DeployCliEnvironmentReport): RuntimeEnvironmentStatus {
  const lines = (report.status ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const lowerLines = lines.map((line) => line.toLowerCase());
  const checks: RuntimeCheck[] = [];
  const consumed = new Set<number>();

  for (const matcher of runtimeCheckMatchers) {
    const okIndex = lowerLines.findIndex((line) => line.includes(matcher.ok));
    const failedIndex = lowerLines.findIndex((line) => line.includes(matcher.failed));

    if (okIndex >= 0) {
      consumed.add(okIndex);
    }
    if (failedIndex >= 0) {
      consumed.add(failedIndex);
    }
    if (okIndex >= 0 || failedIndex >= 0) {
      checks.push({ label: matcher.label, ok: okIndex >= 0 });
    }
  }

  const serviceLines = lines.filter((line, index) => {
    if (consumed.has(index)) {
      return false;
    }

    const lower = lowerLines[index];

    return !lower.startsWith('docker ') && !lower.startsWith('docker compose version');
  });

  return { checks, report, serviceLines };
}

function parseRuntimeReport(stdout: string): DeployCliStatusReport | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');

  if (start < 0 || end <= start) {
    return undefined;
  }

  try {
    return JSON.parse(stdout.slice(start, end + 1)) as DeployCliStatusReport;
  } catch {
    return undefined;
  }
}

function environmentSortKey(environment: string) {
  if (environment === 'prod') {
    return 0;
  }
  if (environment === 'beta') {
    return 1;
  }

  return 2;
}

function sortDeployments(deployments: DeploymentRecordSummary[]) {
  return [...deployments].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || '');
    const rightTime = Date.parse(right.updatedAt || right.createdAt || '');

    return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
  });
}

interface DeploymentRowProps {
  deployment: DeploymentRecordSummary;
  isLive?: boolean;
  pipelineRun?: GitHubWorkflowRunSummary;
  repositoryUrl?: string;
}

function DeploymentRow({ deployment, isLive = false, pipelineRun, repositoryUrl }: DeploymentRowProps) {
  const url = deploymentUrl(deployment);
  const tone = deploymentTone(deployment.status);
  const liveOnline = deployment.live?.status === 'online';
  const branchUrl =
    repositoryUrl && deployment.sourceRef
      ? `${repositoryUrl}/tree/${encodeURIComponent(deployment.sourceRef)}`
      : undefined;
  const needsAttention = tone === 'failed' || (isLive && deployment.live?.status === 'offline');

  return (
    <Surface
      variant="tertiary"
      className={
        isLive
          ? 'grid gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.04] px-3 py-3'
          : 'grid gap-2 rounded-lg border border-neutral-800 bg-black/20 px-3 py-2'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {isLive ? (
          <Chip size="sm" className="border border-emerald-500/40 bg-emerald-500/15 text-emerald-200">
            <Radio className="mr-1 size-3" />
            live
          </Chip>
        ) : null}
        <Chip size="sm" variant={deployment.environment === 'prod' ? 'primary' : 'secondary'}>
          {deployment.environment || 'env unknown'}
        </Chip>
        {deployment.version ? (
          <Chip
            size="sm"
            className="border border-sky-500/30 bg-sky-500/10 font-mono text-sky-200"
            title={deployment.revision ? `Revision ${deployment.revision}` : undefined}
          >
            Version {deployment.version}
          </Chip>
        ) : deployment.revision ? (
          <Chip
            size="sm"
            className="border border-neutral-700 bg-neutral-900 font-mono text-neutral-400"
            title={deployment.revision}
          >
            Revision {shortRevision(deployment.revision)}
          </Chip>
        ) : null}
        <Text className="min-w-0 truncate text-sm font-medium text-neutral-100">
          {deployment.appSlug}
        </Text>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ToneChip label={deployment.status || 'unknown'} tone={tone} />
          <ToneChip
            label={liveStatusLabel(deployment)}
            tone={
              !deployment.live || deployment.live.status === 'unknown'
                ? 'muted'
                : liveOnline
                  ? 'ok'
                  : 'failed'
            }
          />
          {pipelineRun ? (
            <a href={pipelineRun.url} target="_blank" rel="noreferrer">
              <ToneChip label={`CI ${runLabel(pipelineRun)}`} tone={runTone(pipelineRun)} />
            </a>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
        {deployment.sourceRef ? (
          branchUrl ? (
            <a
              href={branchUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 transition hover:text-neutral-200"
            >
              <GitBranch className="size-3" />
              {deployment.sourceRef}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" />
              {deployment.sourceRef}
            </span>
          )
        ) : (
          <span>no source recorded</span>
        )}
        <span title={formatDate(deployment.updatedAt || deployment.createdAt)}>
          deployed {formatRelativeTime(deployment.updatedAt || deployment.createdAt)}
        </span>
        {typeof deployment.live?.latencyMs === 'number' ? (
          <span>{deployment.live.latencyMs}ms response</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <ExternalLinkRow label="site" url={url} />
        {pipelineRun?.url ? <ExternalLinkRow label="pipeline" url={pipelineRun.url} /> : null}
      </div>

      {needsAttention ? (
        <Text className="text-xs text-amber-300/90">
          {tone === 'failed'
            ? 'Deployment did not finish. Check the pipeline run above, then redeploy from a healthy branch.'
            : 'The live URL is not responding. Run the VPS runtime check below to see container status.'}
        </Text>
      ) : null}
    </Surface>
  );
}

export function ProjectDeploymentsPanel({
  projectName,
  repository,
  targetPath
}: ProjectDeploymentsPanelProps) {
  const [platform, setPlatform] = useState<PlatformOverviewResult>();
  const [pipeline, setPipeline] = useState<GitHubPipelineStatusResult>();
  const [lastCheckedAt, setLastCheckedAt] = useState<string>();
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeState>({ environments: [], state: 'idle' });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const isRefreshingRef = useRef(false);
  const repositoryFullName = repository?.fullName;

  useEffect(() => {
    let disposed = false;

    async function refresh() {
      if (isRefreshingRef.current) {
        return;
      }

      isRefreshingRef.current = true;
      setIsRefreshing(true);

      const [nextPlatform, nextPipeline] = await Promise.all([
        projectSpaceClient.getPlatformOverview().catch(() => undefined),
        repositoryFullName
          ? projectSpaceClient.getGitHubPipelineStatus(repositoryFullName).catch(() => undefined)
          : Promise.resolve(undefined)
      ]);

      isRefreshingRef.current = false;

      if (disposed) {
        return;
      }

      setPlatform(nextPlatform);
      setPipeline(nextPipeline);
      setLastCheckedAt(new Date().toISOString());
      setHasLoaded(true);
      setIsRefreshing(false);
    }

    void refresh();
    const interval = setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, refreshIntervalMs);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [repositoryFullName, projectName, refreshNonce]);

  async function checkRuntime() {
    if (!targetPath) {
      return;
    }

    setRuntime({ environments: [], state: 'running' });

    try {
      const result = await projectSpaceClient.runProjectCliCommand({
        command: 'deploy-status',
        cwd: targetPath
      });

      if (result.exitCode !== 0) {
        const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
        const cliMissing = output.includes('enoent') || output.includes('not found');

        setRuntime({
          environments: [],
          message: cliMissing
            ? 'The project CLI is not available on this host. Runtime checks need the desktop app or a machine with the project CLI and SSH access to the VPS.'
            : result.stderr.trim() || result.stdout.trim() || 'Runtime check failed.',
          state: cliMissing ? 'unavailable' : 'error'
        });
        return;
      }

      const report = parseRuntimeReport(result.stdout);

      if (!report) {
        setRuntime({
          environments: [],
          message: 'Could not parse the CLI status report.',
          state: 'error'
        });
        return;
      }

      setRuntime({
        environments: (report.environments ?? []).map(parseRuntimeEnvironment),
        host: report.host,
        state: 'done'
      });
    } catch (error) {
      setRuntime({
        environments: [],
        message: error instanceof Error ? error.message : 'Runtime check failed.',
        state: 'error'
      });
    }
  }

  const projectDeployments = useMemo(
    () =>
      sortDeployments(
        (platform?.deployments ?? []).filter((deployment) =>
          deploymentMatchesProject(deployment, projectName)
        )
      ),
    [platform?.deployments, projectName]
  );

  const liveDeployments = useMemo(() => {
    const byEnvironment = new Map<string, DeploymentRecordSummary>();

    for (const deployment of projectDeployments) {
      const key = deployment.environment || 'unknown';

      if (!byEnvironment.has(key)) {
        byEnvironment.set(key, deployment);
      }
    }

    return [...byEnvironment.values()].sort(
      (left, right) => environmentSortKey(left.environment) - environmentSortKey(right.environment)
    );
  }, [projectDeployments]);

  const historyDeployments = useMemo(() => {
    const liveIds = new Set(
      liveDeployments.map((deployment) => deployment.id || `${deployment.appSlug}-${deployment.environment}`)
    );

    return projectDeployments.filter(
      (deployment) => !liveIds.has(deployment.id || `${deployment.appSlug}-${deployment.environment}`)
    );
  }, [projectDeployments, liveDeployments]);

  const latestRunByBranch = useMemo(() => {
    const byBranch = new Map<string, GitHubWorkflowRunSummary>();

    for (const run of pipeline?.runs ?? []) {
      if (run.branch && !byBranch.has(run.branch)) {
        byBranch.set(run.branch, run);
      }
    }

    return byBranch;
  }, [pipeline?.runs]);

  const pipelineRuns = (pipeline?.runs ?? []).slice(0, 8);
  const platformConfigured = Boolean(platform?.apiBaseUrl);
  const isInitialLoading = isRefreshing && !hasLoaded;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Rocket className="size-4 text-neutral-400" />
        <Text className="text-sm font-semibold text-neutral-100">Deployments</Text>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {lastCheckedAt ? (
            <Text className="text-xs text-neutral-500" title={formatDate(lastCheckedAt)}>
              checked {formatRelativeTime(lastCheckedAt)} · auto-refresh {refreshIntervalMs / 1000}s
            </Text>
          ) : null}
          <ToneChip
            label={
              isInitialLoading
                ? 'checking platform'
                : platform?.apiReachable
                  ? 'platform online'
                  : platformConfigured
                    ? 'platform offline'
                    : 'no platform configured'
            }
            tone={
              isInitialLoading
                ? 'pending'
                : platform?.apiReachable
                  ? 'ok'
                  : platformConfigured
                    ? 'failed'
                    : 'muted'
            }
          />
          <Button
            size="sm"
            variant="ghost"
            isDisabled={isRefreshing}
            onPress={() => setRefreshNonce((nonce) => nonce + 1)}
          >
            <RefreshCw className={isRefreshing ? 'size-4 animate-spin' : 'size-4'} />
            Refresh
          </Button>
        </div>
      </div>

      {isInitialLoading ? (
        <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 px-3 py-3">
          <div className="flex items-center gap-3">
            <RefreshCw className="size-4 animate-spin text-neutral-400" />
            <Text className="text-sm text-neutral-300">
              Loading deployments, live checks and pipeline status...
            </Text>
          </div>
        </Surface>
      ) : null}

      {!isInitialLoading && platform?.error ? (
        <Surface variant="tertiary" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2">
          <Text className="text-sm text-red-200">{platform.error}</Text>
          <Text className="mt-1 block text-xs text-red-200/70">
            Deployment history needs a reachable private VPS platform API. Local work is unaffected.
          </Text>
        </Surface>
      ) : null}

      {!isInitialLoading ? (
        <section className="grid gap-2">
          <div className="flex items-center gap-2">
            <Radio className="size-4 text-neutral-400" />
            <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
              Live on VPS
            </Text>
          </div>
          {liveDeployments.length > 0 ? (
            liveDeployments.map((deployment) => (
              <DeploymentRow
                key={`live-${deployment.id || `${deployment.appSlug}-${deployment.environment}`}`}
                deployment={deployment}
                isLive
                pipelineRun={
                  deployment.sourceRef ? latestRunByBranch.get(deployment.sourceRef) : undefined
                }
                repositoryUrl={repository?.url}
              />
            ))
          ) : (
            <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 px-3 py-2">
              <Text className="text-sm text-neutral-400">
                {platform?.apiReachable
                  ? 'No deployments were found for this project on the VPS platform.'
                  : 'Connect the private VPS platform to see what is live for this project.'}
              </Text>
            </Surface>
          )}
        </section>
      ) : null}

      {!isInitialLoading && historyDeployments.length > 0 ? (
        <section className="grid gap-2">
          <div className="flex items-center gap-2">
            <History className="size-4 text-neutral-400" />
            <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
              Previous deployments
            </Text>
          </div>
          {historyDeployments.map((deployment) => (
            <DeploymentRow
              key={deployment.id || `${deployment.appSlug}-${deployment.environment}-${deployment.createdAt}`}
              deployment={deployment}
              pipelineRun={
                deployment.sourceRef ? latestRunByBranch.get(deployment.sourceRef) : undefined
              }
              repositoryUrl={repository?.url}
            />
          ))}
        </section>
      ) : null}

      {!isInitialLoading ? (
        <section className="grid gap-2">
          <div className="flex items-center gap-2">
            <Workflow className="size-4 text-neutral-400" />
            <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
              GitHub pipeline
            </Text>
          </div>
          {!repositoryFullName ? (
            <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 px-3 py-2">
              <Text className="text-sm text-neutral-400">
                No GitHub repository is linked to this project, so pipeline status is unavailable.
              </Text>
            </Surface>
          ) : pipeline && pipeline.status !== 'connected' ? (
            <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 px-3 py-2">
              <Text className="text-sm text-neutral-400">
                {pipeline.message ?? 'Connect GitHub to see workflow runs.'}
              </Text>
            </Surface>
          ) : pipelineRuns.length > 0 ? (
            <div className="grid gap-1.5">
              {pipelineRuns.map((run) => (
                <a
                  key={run.id}
                  href={run.url}
                  target="_blank"
                  rel="noreferrer"
                  className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-neutral-800 bg-black/20 px-3 py-2 transition hover:border-neutral-700"
                >
                  <RunStatusIcon run={run} />
                  <div className="min-w-0">
                    <Text className="block truncate text-sm text-neutral-100 group-hover:text-white">
                      {run.displayTitle || run.name || `Run #${run.runNumber ?? run.id}`}
                    </Text>
                    <Text className="block truncate text-xs text-neutral-500">
                      {[run.name, run.branch, run.event].filter(Boolean).join(' · ')}
                    </Text>
                  </div>
                  <div className="flex items-center gap-2">
                    <Text className="text-xs text-neutral-500" title={formatDate(run.updatedAt)}>
                      {[formatRunDuration(run), formatRelativeTime(run.updatedAt)]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                    <ToneChip label={runLabel(run)} tone={runTone(run)} />
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 px-3 py-2">
              <Text className="text-sm text-neutral-400">No workflow runs found for this repository.</Text>
            </Surface>
          )}
        </section>
      ) : null}

      {!isInitialLoading ? (
        <section className="grid gap-2">
          <div className="flex items-center gap-2">
            <ServerCog className="size-4 text-neutral-400" />
            <Text className="text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500">
              VPS runtime
            </Text>
            {runtime.host ? (
              <Text className="text-xs text-neutral-500">host {runtime.host}</Text>
            ) : null}
            <div className="ml-auto">
              <Button
                size="sm"
                variant="ghost"
                isDisabled={runtime.state === 'running' || !targetPath}
                onPress={() => void checkRuntime()}
              >
                {runtime.state === 'running' ? (
                  <RefreshCw className="size-4 animate-spin" />
                ) : (
                  <ServerCog className="size-4" />
                )}
                {runtime.state === 'running' ? 'Checking VPS...' : 'Check runtime'}
              </Button>
            </div>
          </div>

          {runtime.state === 'idle' ? (
            <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 px-3 py-2">
              <Text className="text-sm text-neutral-400">
                Run the project CLI deploy status to verify SSH, Docker, Traefik and the running
                containers for each environment. Needs the project CLI on this machine.
              </Text>
            </Surface>
          ) : null}

          {runtime.state === 'unavailable' || runtime.state === 'error' ? (
            <Surface
              variant="tertiary"
              className={
                runtime.state === 'unavailable'
                  ? 'rounded-lg border border-neutral-800 bg-black/20 px-3 py-2'
                  : 'rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2'
              }
            >
              <Text
                className={
                  runtime.state === 'unavailable' ? 'text-sm text-neutral-400' : 'text-sm text-red-200'
                }
              >
                {runtime.message}
              </Text>
            </Surface>
          ) : null}

          {runtime.state === 'done'
            ? runtime.environments.map((environment) => (
                <Surface
                  key={environment.report.environment}
                  variant="tertiary"
                  className="grid gap-2 rounded-lg border border-neutral-800 bg-black/20 px-3 py-2"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip
                      size="sm"
                      variant={environment.report.environment === 'prod' ? 'primary' : 'secondary'}
                    >
                      {environment.report.environment}
                    </Chip>
                    {environment.checks.map((check) => (
                      <ToneChip
                        key={check.label}
                        label={check.label}
                        tone={check.ok ? 'ok' : 'failed'}
                      />
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <ExternalLinkRow label="web" url={environment.report.webUrl} />
                    <ExternalLinkRow label="api" url={environment.report.apiUrl} />
                  </div>
                  {environment.serviceLines.length > 0 ? (
                    <pre className="max-h-48 overflow-auto rounded-md border border-neutral-900 bg-neutral-950/80 p-2 font-mono text-xs leading-relaxed text-neutral-400">
                      {environment.serviceLines.join('\n')}
                    </pre>
                  ) : null}
                </Surface>
              ))
            : null}
        </section>
      ) : null}
    </div>
  );
}
