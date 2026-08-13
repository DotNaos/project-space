import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  Bot,
  Circle,
  ExternalLink,
  LoaderCircle,
  Play,
  RefreshCw
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
import type { CodexAuthorizationResult } from '@/shared/codex-authorization-api';
import type { CodexMachineTaskExistingResult } from '@/shared/codex-machine-tasks-api';
import type { GitHubCodespaceRunnerResult } from '@/shared/github-codespace-runner-api';
import type { GitHubOAuthDeviceStartResult } from '@/shared/project-space-api';
import { createBrowserRandomUuid } from '@/shared/browser-random-uuid';
import { codexSessionRoute } from '../../codex-sessions/codex-session-route';
import { GitHubMark } from './github-mark';
import {
  GitHubCodespaceConnectionPanel,
  type GitHubCodespaceFlowFailure
} from './github-codespace-connection-panel';
import {
  githubCodespaceLaunchAction,
  GitHubCodespacePicker,
  preserveCodespaceChoices
} from './github-codespace-picker';
import { getGitHubReauthorizationAction } from './github-reauthorization-action';
import type { IssueCodexDialogFooterAction } from './issue-codex-start-dialog';

interface GitHubCodespaceDestinationProps {
  availableConnectorIds: readonly string[];
  branch: string;
  embedded?: boolean;
  issue: number;
  onExistingTaskChange?(task?: GitHubCodespaceExistingTask): void;
  onStart(input: {
    connectorId: string;
    environmentId: string;
    name: string;
  }): void;
  probeOnly?: boolean;
  repositoryFullName: string;
  children?(state: GitHubCodespaceDestinationRenderState): ReactNode;
}

export interface GitHubCodespaceLaunchStatus {
  kind: 'error' | 'pending';
  message: string;
}

export interface GitHubCodespaceDestinationRenderState {
  content: ReactNode;
  footerAction: IssueCodexDialogFooterAction;
  launchStatus?: GitHubCodespaceLaunchStatus;
}

export interface GitHubCodespaceExistingTask {
  environmentLabel: string;
  key: string;
  physicalMachineName: string;
  result: Exclude<CodexMachineTaskExistingResult, { state: 'missing' }>;
}

function operation(prefix: 'authorization' | 'codespace') {
  return `${prefix}:${createBrowserRandomUuid()}`;
}

const codespaceOperationPattern = /^codespace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const codespaceTransitionStates = new Set([
  'provisioning',
  'queued',
  'rebuilding',
  'shuttingdown',
  'starting',
  'stopping'
]);
const codespaceLaunchTimeoutMs = 3 * 60 * 1_000;

export function GitHubCodespaceDestination({
  availableConnectorIds,
  branch,
  embedded = false,
  issue,
  onExistingTaskChange,
  onStart,
  probeOnly = false,
  repositoryFullName,
  children
}: GitHubCodespaceDestinationProps) {
  const [runner, setRunner] = useState<GitHubCodespaceRunnerResult>();
  const [authorization, setAuthorization] = useState<CodexAuthorizationResult>();
  const [githubFlow, setGitHubFlow] = useState<GitHubOAuthDeviceStartResult>();
  const [existingTask, setExistingTask] = useState<CodexMachineTaskExistingResult>();
  const [existingTaskError, setExistingTaskError] = useState('');
  const [checkingExistingTask, setCheckingExistingTask] = useState(false);
  const [flowModalOpen, setFlowModalOpen] = useState(false);
  const [flowFailure, setFlowFailure] = useState<GitHubCodespaceFlowFailure>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [selectedCodespaceName, setSelectedCodespaceName] = useState<string>();
  const [launchRequested, setLaunchRequested] = useState(false);
  const [launchAttempted, setLaunchAttempted] = useState(false);
  const [existingTaskCheckedFor, setExistingTaskCheckedFor] = useState('');
  const statusOperation = useRef(operation('codespace'));
  const authorizationOperation = useRef('');
  const runnerPollInFlight = useRef(false);
  const launchMutationInFlight = useRef(false);
  const launchStartedAt = useRef<number | undefined>(undefined);
  const authorizationPollInFlight = useRef(false);
  const githubPollInFlight = useRef(false);

  async function run(
    action: 'delete' | 'provision' | 'start' | 'status' | 'stop',
    requestedCodespaceName: string | null | undefined = selectedCodespaceName,
    silent = false
  ): Promise<GitHubCodespaceRunnerResult | undefined> {
    const codespaceName = requestedCodespaceName ?? undefined;
    if (!silent) {
      setBusy(action);
      setError('');
      setFlowFailure(undefined);
    }
    try {
      if (!codespaceOperationPattern.test(statusOperation.current)) {
        statusOperation.current = operation('codespace');
      }
      const next = await projectSpaceClient.runGitHubCodespace({
        action,
        branch,
        ...(codespaceName ? { codespaceName } : {}),
        issue,
        ...(action === 'status' && !codespaceName ? { listOnly: true } : {}),
        operationId: action === 'status' ? statusOperation.current : operation('codespace'),
        repositoryFullName
      });
      if (next.codespace?.name) setSelectedCodespaceName(next.codespace.name);
      setRunner((current) => preserveCodespaceChoices(next, current));
      if (silent) setError('');
      return next;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The Codespace could not be updated.';
      setError(message);
      if (!silent) setFlowFailure({ message, retry: 'status' });
      return undefined;
    } finally {
      if (!silent) setBusy('');
    }
  }

  async function startGitHubLogin() {
    setBusy('github-login');
    setError('');
    setFlowFailure(undefined);
    try {
      const next = await projectSpaceClient.startGitHubOAuthDeviceFlow();
      setGitHubFlow(next);
      if (next.status !== 'pending') {
        const message = next.message ?? 'GitHub authorization could not be started.';
        setError(message);
        setFlowFailure({ message, retry: 'github' });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'GitHub authorization could not be started.';
      setError(message);
      setFlowFailure({ message, retry: 'github' });
    } finally {
      setBusy('');
    }
  }

  async function checkGitHubLogin(silent = false) {
    if (!githubFlow?.deviceCode) return;
    if (githubPollInFlight.current) return;
    githubPollInFlight.current = true;
    if (!silent) {
      setBusy('github-login');
      setFlowFailure(undefined);
    }
    try {
      const next = await projectSpaceClient.pollGitHubOAuthDeviceFlow({
        deviceCode: githubFlow.deviceCode
      });
      if (next.status === 'connected') {
        setGitHubFlow(undefined);
        await run('status', undefined, silent);
      } else if (next.status === 'pending') {
        if (next.intervalSeconds) {
          setGitHubFlow((current) => current
            ? { ...current, intervalSeconds: next.intervalSeconds }
            : current);
        }
      } else {
        const message = next.message ?? 'GitHub authorization was not completed.';
        setGitHubFlow(undefined);
        setError(message);
        setFlowFailure({ message, retry: 'github' });
      }
    } catch (cause) {
      if (!silent) {
        const message = cause instanceof Error ? cause.message : 'GitHub authorization could not be checked.';
        setError(message);
        setFlowFailure({ message, retry: 'github' });
      }
    } finally {
      githubPollInFlight.current = false;
      if (!silent) setBusy('');
    }
  }

  async function authorizeCodex(
    action: 'cancel' | 'start' | 'status',
    silent = false
  ) {
    if (!runner?.connectorId || !runner.environmentId) return;
    if (!authorizationOperation.current || action === 'start') {
      authorizationOperation.current = operation('authorization');
    }
    if (!silent) {
      setBusy('authorization');
      setError('');
      setFlowFailure(undefined);
    }
    try {
      const next = await projectSpaceClient.authorizeCodex({
        action,
        connectorId: runner.connectorId,
        environmentId: runner.environmentId,
        operationId: authorizationOperation.current
      });
      setAuthorization(next);
      if (next.state === 'ready') await run('status', undefined, silent);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Codex authorization failed safely.';
      if (!silent) {
        setError(message);
        setFlowFailure({ message, retry: 'codex' });
      }
    } finally {
      if (!silent) setBusy('');
    }
  }

  async function pollRunner() {
    if (runnerPollInFlight.current) return;
    runnerPollInFlight.current = true;
    try {
      await run('status', undefined, true);
    } finally {
      runnerPollInFlight.current = false;
    }
  }

  async function pollAuthorization() {
    if (authorizationPollInFlight.current) return;
    authorizationPollInFlight.current = true;
    try {
      await authorizeCodex('status', true);
    } finally {
      authorizationPollInFlight.current = false;
    }
  }

  useEffect(() => {
    setRunner(undefined);
    setAuthorization(undefined);
    setGitHubFlow(undefined);
    setExistingTask(undefined);
    setExistingTaskError('');
    setSelectedCodespaceName(undefined);
    setLaunchRequested(false);
    setLaunchAttempted(false);
    setExistingTaskCheckedFor('');
    statusOperation.current = operation('codespace');
    authorizationOperation.current = '';
    void run('status', null);
  }, [branch, issue, repositoryFullName]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let hasChecked = false;
    if (!runner) return;
    if (!runner.connectorId) {
      setCheckingExistingTask(false);
      setExistingTaskCheckedFor('');
      return;
    }
    const connectorId = runner.connectorId;
    const codespaceName = runner.codespace?.name;

    async function refreshExistingTask() {
      if (inFlight) return;
      inFlight = true;
      const showPending = !hasChecked;
      if (showPending) setCheckingExistingTask(true);
      try {
        const result = await projectSpaceClient.getExistingCodexMachineTask({
          connectorId,
          issue,
          repositoryId: repositoryFullName
        });
        if (cancelled) return;
        hasChecked = true;
        setExistingTaskError('');
        setExistingTaskCheckedFor(connectorId);
        setExistingTask(result);
        onExistingTaskChange?.(result.state === 'missing'
          ? undefined
          : {
              environmentLabel: result.state === 'confirmed'
                ? result.task.environment?.name ?? codespaceName ?? 'Codespace'
                : codespaceName ?? 'Codespace',
              key: connectorId,
              physicalMachineName: 'GitHub Codespace',
              result
            });
      } catch (cause) {
        if (cancelled) return;
        hasChecked = true;
        setExistingTaskCheckedFor(connectorId);
        setExistingTaskError(
          cause instanceof Error ? cause.message : 'Existing tasks could not be checked.'
        );
      } finally {
        inFlight = false;
        if (!cancelled && showPending) setCheckingExistingTask(false);
      }
    }

    void refreshExistingTask();
    const timer = window.setInterval(() => void refreshExistingTask(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [issue, onExistingTaskChange, repositoryFullName, runner?.codespace?.name, runner?.connectorId]);

  useEffect(() => {
    if (!runner || (
      !launchRequested
      &&
      !['provisioning', 'connector-approval-required'].includes(runner.state)
      && !codespaceTransitionStates.has(runner.codespace?.state.toLowerCase() ?? '')
    )) return;
    const timer = window.setInterval(() => void pollRunner(), 4_000);
    return () => window.clearInterval(timer);
  }, [launchRequested, runner?.codespace?.state, runner?.state]);

  useEffect(() => {
    if (githubFlow?.status !== 'pending' || !githubFlow.deviceCode) return;
    const intervalMs = Math.max(githubFlow.intervalSeconds ?? 5, 5) * 1_000;
    const timer = window.setInterval(() => void checkGitHubLogin(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [githubFlow?.deviceCode, githubFlow?.intervalSeconds, githubFlow?.status]);

  useEffect(() => {
    if (authorization?.state !== 'pending') return;
    const timer = window.setInterval(() => void pollAuthorization(), 3_000);
    return () => window.clearInterval(timer);
  }, [authorization?.state, runner?.connectorId, runner?.environmentId]);

  useEffect(() => {
    if (
      githubFlow?.status === 'pending'
      || authorization?.state === 'pending'
      || runner?.state === 'connector-approval-required'
      || runner?.state === 'failed'
      || flowFailure
    ) {
      setFlowModalOpen(true);
    }
  }, [authorization?.state, flowFailure, githubFlow?.status, runner?.state]);

  const online = runner?.state === 'ready' || runner?.state === 'authorization-required';
  const pending = busy !== '' || runner?.state === 'provisioning';
  const connectorAvailable = Boolean(
    runner?.connectorId && availableConnectorIds.includes(runner.connectorId)
  );
  const name = runner?.codespace?.name ?? 'New task Codespace';
  const existingAction = existingTask?.state === 'confirmed'
    ? existingTask.action === 'open-running'
      ? 'Open running task'
      : existingTask.action === 'resolve'
        ? 'Resolve task problem'
        : 'Continue task'
    : existingTask?.state === 'attention'
      ? 'Resolve task problem'
      : undefined;
  const modalKind = githubFlow?.status === 'pending'
    ? 'github'
    : authorization?.state === 'pending'
      ? 'codex'
      : runner?.state === 'connector-approval-required'
        ? 'connector'
        : runner?.state === 'failed'
          ? 'connection'
          : flowFailure
            ? 'connection'
            : undefined;
  const githubReauthorizationAction = getGitHubReauthorizationAction({
    embedded,
    flowPending: githubFlow?.status === 'pending'
  });

  const openExistingTask = useCallback(() => {
    if (existingTask?.state === 'attention') {
      setError(existingTask.message);
      return;
    }
    if (existingTask?.state !== 'confirmed') return;
    window.location.assign(codexSessionRoute({
      machineId: existingTask.task.connector.id,
      threadId: existingTask.task.threadId
    }));
  }, [existingTask]);

  const launchAction = githubCodespaceLaunchAction(runner, selectedCodespaceName);
  const startDisabled = Boolean(busy)
    || launchRequested
    || !launchAction;
  const startPending = launchRequested || busy === 'provision' || busy === 'start';
  const runLaunchMutation = useCallback(async (action: 'provision' | 'start') => {
    if (launchMutationInFlight.current) return;
    launchMutationInFlight.current = true;
    try {
      await run(action, action === 'start' ? selectedCodespaceName : null);
    } finally {
      launchMutationInFlight.current = false;
    }
  }, [selectedCodespaceName]);
  const startCodespaceDevelopment = useCallback(() => {
    if (!launchAction) return;
    launchStartedAt.current = Date.now();
    setLaunchAttempted(true);
    setLaunchRequested(true);
    setError('');
    if (launchAction === 'provision') {
      void runLaunchMutation('provision');
      return;
    }
    if (launchAction === 'start') {
      void runLaunchMutation('start');
      return;
    }
    void pollRunner();
  }, [launchAction, runLaunchMutation]);

  useEffect(() => {
    if (!launchRequested || busy || launchAction !== 'start') return;
    void runLaunchMutation('start');
  }, [busy, launchAction, launchRequested, runLaunchMutation]);

  useEffect(() => {
    if (!launchRequested) {
      launchStartedAt.current = undefined;
      return;
    }
    launchStartedAt.current ??= Date.now();
    const remaining = Math.max(
      0,
      codespaceLaunchTimeoutMs - (Date.now() - launchStartedAt.current)
    );
    const timer = window.setTimeout(() => {
      setLaunchRequested(false);
      setError(
        'The Codespace did not become ready within three minutes. It may still be starting; check its status and try again.'
      );
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [launchRequested]);

  useEffect(() => {
    if (!launchRequested || !runner) return;
    if (runner.state === 'failed' || existingTaskError) {
      setLaunchRequested(false);
      return;
    }
    if (
      runner.state !== 'ready'
      || !runner.connectorId
      || !runner.environmentId
      || !connectorAvailable
      || checkingExistingTask
      || existingTaskCheckedFor !== runner.connectorId
    ) return;
    setLaunchRequested(false);
    if (existingAction) {
      openExistingTask();
      return;
    }
    onStart({
      connectorId: runner.connectorId,
      environmentId: runner.environmentId,
      name
    });
  }, [
    checkingExistingTask,
    connectorAvailable,
    existingAction,
    existingTaskCheckedFor,
    existingTaskError,
    launchRequested,
    name,
    onStart,
    openExistingTask,
    runner
  ]);
  const dialogFooterAction = useMemo(() => ({
    isDisabled: startDisabled,
    isPending: startPending,
    label: startPending ? 'Starting…' : undefined,
    onPress: startCodespaceDevelopment
  }), [busy, launchRequested, startCodespaceDevelopment, startDisabled, startPending]);

  if (probeOnly) return null;

  const launchStatus: GitHubCodespaceLaunchStatus | undefined = launchRequested
    ? {
        kind: 'pending',
        message: runner?.message ?? 'Starting the selected Codespace…'
      }
    : launchAttempted && (error || existingTaskError || runner?.state === 'failed')
      ? {
          kind: 'error',
          message: error || existingTaskError || runner?.message || 'The Codespace could not be started.'
        }
      : undefined;

  const content = (
    <div className="grid gap-2">
      <div className={embedded
        ? 'grid min-w-0 gap-2'
        : 'grid min-w-0 gap-3 rounded-2xl bg-current/[.04] px-3 py-3'}>
        {!embedded ? (
          <div className="flex min-w-0 items-center gap-2">
            <GitHubMark className="size-3.5 shrink-0 text-current/30" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-current/65">
              GitHub Codespace · {name}
            </span>
            {pending ? (
              <LoaderCircle aria-label="Working" className="size-3.5 shrink-0 animate-spin text-sky-300" />
            ) : (
              <Circle aria-label={online ? 'Online' : 'Offline'} className={`size-2.5 shrink-0 fill-current ${online ? 'text-emerald-400' : 'text-current/20'}`} />
            )}
          </div>
        ) : null}

        {runner && runner.state !== 'github-reauthorization-required' ? (
          <GitHubCodespacePicker
            codespaces={runner.codespaces ?? []}
            isDisabled={Boolean(busy)}
            onChange={(codespaceName) => {
              setSelectedCodespaceName(codespaceName);
              setLaunchRequested(false);
              setLaunchAttempted(false);
              setExistingTask(undefined);
              setExistingTaskCheckedFor('');
              setExistingTaskError('');
              void run('status', codespaceName ?? null);
            }}
            value={selectedCodespaceName}
          />
        ) : null}

        {runner?.state === 'github-reauthorization-required' && githubReauthorizationAction ? (
          <Button className={`${embedded ? 'mx-3 w-[calc(100%-1.5rem)]' : 'w-full'} shrink-0 whitespace-nowrap rounded-full`} isDisabled={Boolean(busy)} size="sm" variant={githubReauthorizationAction.variant} onPress={() => githubFlow?.status === 'pending' ? setFlowModalOpen(true) : void startGitHubLogin()}>
            <RefreshCw className="size-3.5" /> {githubReauthorizationAction.label}
          </Button>
        ) : runner?.state === 'connector-approval-required' && runner.approvalUrl ? (
          <Button className={`${embedded ? 'mx-3 w-[calc(100%-1.5rem)]' : 'w-full'} shrink-0 whitespace-nowrap rounded-full`} size="sm" variant="ghost" onPress={() => setFlowModalOpen(true)}>
            Approve connector <ExternalLink className="size-3.5" />
          </Button>
        ) : runner?.state === 'authorization-required' ? (
          <Button className={`${embedded ? 'mx-3 w-[calc(100%-1.5rem)]' : 'w-full'} shrink-0 whitespace-nowrap rounded-full`} isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => authorization?.state === 'pending' ? setFlowModalOpen(true) : void authorizeCodex('start')}>
            <Bot className="size-3.5" /> {authorization?.state === 'pending' ? 'Continue Codex sign in' : 'Sign in to Codex'}
          </Button>
        ) : runner?.state === 'failed' && !embedded ? (
          <Button className={`${embedded ? 'mx-3 w-[calc(100%-1.5rem)]' : 'w-full'} shrink-0 whitespace-nowrap rounded-full`} isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => setFlowModalOpen(true)}>
            <RefreshCw className="size-3.5" /> Resolve connection
          </Button>
        ) : null}
      </div>

      {!embedded ? (
        <p className="px-3 text-[11px] leading-5 text-current/40">
          {runner?.message ?? 'Checking GitHub Codespaces…'}
        </p>
      ) : null}
      {error && !(embedded && flowFailure) ? (
        <p className="px-3 text-xs text-red-300">{error}</p>
      ) : null}
      {existingTaskError ? (
        <p className="px-3 text-xs text-red-300">{existingTaskError}</p>
      ) : null}
    </div>
  );

  const connectionPanel = (
    <GitHubCodespaceConnectionPanel
      authorization={authorization}
      busy={Boolean(busy)}
      embedded={embedded}
      failure={flowFailure}
      githubFlow={githubFlow}
      isOpen={flowModalOpen}
      kind={modalKind}
      onAuthorizeCodex={(action) => void authorizeCodex(action)}
      onCheckGitHub={() => void checkGitHubLogin()}
      onOpenChange={setFlowModalOpen}
      onRetry={() => flowFailure?.retry === 'github'
        ? void startGitHubLogin()
        : flowFailure?.retry === 'codex'
          ? void authorizeCodex('start')
          : void run('status')}
      runner={runner}
    />
  );

  if (children) {
    return (
      <>
        {children({ content, footerAction: dialogFooterAction, launchStatus })}
        {connectionPanel}
      </>
    );
  }

  return (
    <div className="grid gap-2">
      {content}
      <Button
        className="h-10 min-h-10 w-full whitespace-nowrap !rounded-full"
        isDisabled={startDisabled}
        size="sm"
        variant="primary"
        onPress={startCodespaceDevelopment}
      >
        {startPending
          ? <LoaderCircle className="size-3.5 animate-spin" />
          : <Play className="size-3.5" />}
        {busy ? 'Starting…' : existingAction ?? 'Start development'}
      </Button>
      {connectionPanel}
    </div>
  );
}
