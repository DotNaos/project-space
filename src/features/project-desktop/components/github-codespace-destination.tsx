import { useEffect, useRef, useState } from 'react';
import { Modal } from '@heroui/react';
import {
  Bot,
  Circle,
  Cloud,
  Copy,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Trash2
} from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { Button } from '@/app/dotnaos-ui';
import type { CodexAuthorizationResult } from '@/shared/codex-authorization-api';
import type { CodexMachineTaskExistingResult } from '@/shared/codex-machine-tasks-api';
import type { GitHubCodespaceRunnerResult } from '@/shared/github-codespace-runner-api';
import type { GitHubOAuthDeviceStartResult } from '@/shared/project-space-api';
import { codexSessionRoute } from '../../codex-sessions/codex-session-route';

interface GitHubCodespaceDestinationProps {
  branch: string;
  issue: number;
  onStart(input: {
    connectorId: string;
    environmentId: string;
    name: string;
  }): void;
  repositoryFullName: string;
}

function operation(prefix: 'authorization' | 'codespace') {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}

export function GitHubCodespaceDestination({
  branch,
  issue,
  onStart,
  repositoryFullName
}: GitHubCodespaceDestinationProps) {
  const [runner, setRunner] = useState<GitHubCodespaceRunnerResult>();
  const [authorization, setAuthorization] = useState<CodexAuthorizationResult>();
  const [githubFlow, setGitHubFlow] = useState<GitHubOAuthDeviceStartResult>();
  const [existingTask, setExistingTask] = useState<CodexMachineTaskExistingResult>();
  const [checkingExistingTask, setCheckingExistingTask] = useState(false);
  const [flowModalOpen, setFlowModalOpen] = useState(false);
  const [flowFailure, setFlowFailure] = useState<{
    message: string;
    retry: 'codex' | 'github' | 'status';
  }>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const statusOperation = useRef(operation('codespace'));
  const authorizationOperation = useRef('');
  const runnerPollInFlight = useRef(false);
  const authorizationPollInFlight = useRef(false);

  async function run(action: 'delete' | 'provision' | 'start' | 'status' | 'stop') {
    setBusy(action);
    setError('');
    setFlowFailure(undefined);
    try {
      const next = await projectSpaceClient.runGitHubCodespace({
        action,
        branch,
        issue,
        operationId: action === 'status' ? statusOperation.current : operation('codespace'),
        repositoryFullName
      });
      setRunner(next);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The Codespace could not be updated.';
      setError(message);
      setFlowFailure({ message, retry: 'status' });
    } finally {
      setBusy('');
    }
  }

  async function startGitHubLogin() {
    setBusy('github-login');
    setError('');
    setFlowFailure(undefined);
    try {
      setGitHubFlow(await projectSpaceClient.startGitHubOAuthDeviceFlow());
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'GitHub authorization could not be started.';
      setError(message);
      setFlowFailure({ message, retry: 'github' });
    } finally {
      setBusy('');
    }
  }

  async function checkGitHubLogin() {
    if (!githubFlow?.deviceCode) return;
    setBusy('github-login');
    setFlowFailure(undefined);
    try {
      const next = await projectSpaceClient.pollGitHubOAuthDeviceFlow({
        deviceCode: githubFlow.deviceCode
      });
      if (next.status === 'connected') {
        setGitHubFlow(undefined);
        await run('status');
      } else if (next.status !== 'pending') {
        setError(next.message ?? 'GitHub authorization was not completed.');
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'GitHub authorization could not be checked.';
      setError(message);
      setFlowFailure({ message, retry: 'github' });
    } finally {
      setBusy('');
    }
  }

  async function authorizeCodex(action: 'cancel' | 'start' | 'status') {
    if (!runner?.connectorId || !runner.environmentId) return;
    if (!authorizationOperation.current || action === 'start') {
      authorizationOperation.current = operation('authorization');
    }
    setBusy('authorization');
    setError('');
    setFlowFailure(undefined);
    try {
      const next = await projectSpaceClient.authorizeCodex({
        action,
        connectorId: runner.connectorId,
        environmentId: runner.environmentId,
        operationId: authorizationOperation.current
      });
      setAuthorization(next);
      if (next.state === 'ready') await run('status');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Codex authorization failed safely.';
      setError(message);
      setFlowFailure({ message, retry: 'codex' });
    } finally {
      setBusy('');
    }
  }

  async function pollRunner() {
    if (runnerPollInFlight.current) return;
    runnerPollInFlight.current = true;
    try {
      await run('status');
    } finally {
      runnerPollInFlight.current = false;
    }
  }

  async function pollAuthorization() {
    if (authorizationPollInFlight.current) return;
    authorizationPollInFlight.current = true;
    try {
      await authorizeCodex('status');
    } finally {
      authorizationPollInFlight.current = false;
    }
  }

  useEffect(() => {
    setRunner(undefined);
    setAuthorization(undefined);
    setGitHubFlow(undefined);
    statusOperation.current = operation('codespace');
    authorizationOperation.current = '';
    void pollRunner();
  }, [branch, issue, repositoryFullName]);

  useEffect(() => {
    let cancelled = false;
    if (runner?.state !== 'ready' || !runner.connectorId) {
      setExistingTask(undefined);
      setCheckingExistingTask(false);
      return;
    }
    setCheckingExistingTask(true);
    void projectSpaceClient.getExistingCodexMachineTask({
      connectorId: runner.connectorId,
      issue,
      repositoryId: repositoryFullName
    }).then((result) => {
      if (!cancelled) setExistingTask(result);
    }).catch(() => {
      if (!cancelled) setExistingTask(undefined);
    }).finally(() => {
      if (!cancelled) setCheckingExistingTask(false);
    });
    return () => { cancelled = true; };
  }, [issue, repositoryFullName, runner?.connectorId, runner?.state]);

  useEffect(() => {
    if (!runner || !['provisioning', 'connector-approval-required'].includes(runner.state)) return;
    const timer = window.setInterval(() => void pollRunner(), 4_000);
    return () => window.clearInterval(timer);
  }, [runner?.state]);

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

  function openExistingTask() {
    if (existingTask?.state === 'attention') {
      setError(existingTask.message);
      return;
    }
    if (existingTask?.state !== 'confirmed') return;
    window.location.assign(codexSessionRoute({
      machineId: existingTask.task.connector.id,
      threadId: existingTask.task.threadId
    }));
  }

  return (
    <div className="grid gap-2">
      <div className="flex min-h-11 min-w-0 items-center gap-2 rounded-2xl bg-current/[.04] px-3">
        <Cloud className="size-3.5 shrink-0 text-current/30" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-current/65">
          GitHub Codespace · {name}
        </span>
        {pending ? (
          <LoaderCircle aria-label="Working" className="size-3.5 animate-spin text-sky-300" />
        ) : (
          <Circle aria-label={online ? 'Online' : 'Offline'} className={`size-2.5 fill-current ${online ? 'text-emerald-400' : 'text-current/20'}`} />
        )}

        {runner?.state === 'not-created' ? (
          <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => void run('provision')}>
            <Cloud className="size-3.5" /> Create
          </Button>
        ) : runner?.state === 'github-reauthorization-required' ? (
          <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => githubFlow?.status === 'pending' ? setFlowModalOpen(true) : void startGitHubLogin()}>
            <RefreshCw className="size-3.5" /> {githubFlow?.status === 'pending' ? 'Continue GitHub login' : 'Reconnect GitHub'}
          </Button>
        ) : runner?.state === 'connector-approval-required' && runner.approvalUrl ? (
          <Button size="sm" variant="ghost" onPress={() => setFlowModalOpen(true)}>
            Approve connector <ExternalLink className="size-3.5" />
          </Button>
        ) : runner?.state === 'authorization-required' ? (
          <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => authorization?.state === 'pending' ? setFlowModalOpen(true) : void authorizeCodex('start')}>
            <Bot className="size-3.5" /> {authorization?.state === 'pending' ? 'Continue Codex sign in' : 'Sign in to Codex'}
          </Button>
        ) : runner?.state === 'failed' ? (
          <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => setFlowModalOpen(true)}>
            <RefreshCw className="size-3.5" /> Resolve connection
          </Button>
        ) : runner?.state === 'offline' ? (
          <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => void run('start')}>
            Start Codespace
          </Button>
        ) : runner?.state === 'ready' && runner.connectorId && runner.environmentId ? (
          <Button
            isDisabled={Boolean(busy) || checkingExistingTask}
            size="sm"
            variant="ghost"
            onPress={() => existingAction
              ? openExistingTask()
              : onStart({
                  connectorId: runner.connectorId!,
                  environmentId: runner.environmentId!,
                  name
                })}
          >
            <Bot className="size-3.5" />
            {checkingExistingTask ? 'Checking task…' : existingAction ?? 'Start Codex'}
          </Button>
        ) : null}
      </div>

      <p className="px-3 text-[11px] leading-5 text-current/40">
        {runner?.message ?? 'Checking GitHub Codespaces…'}
      </p>

      {runner?.codespace ? (
        <details className="px-3 text-[11px] text-current/35">
          <summary className="cursor-pointer">Codespace controls</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {runner.codespace.url ? <a href={runner.codespace.url} rel="noreferrer" target="_blank"><Button size="sm" variant="ghost">Open <ExternalLink className="size-3.5" /></Button></a> : null}
            <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => void run('stop')}>Stop</Button>
            <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => void run('delete')}><Trash2 className="size-3.5" /> Delete</Button>
          </div>
        </details>
      ) : null}
      {error ? <p className="px-3 text-xs text-red-300">{error}</p> : null}

      <Modal isOpen={Boolean(modalKind) && flowModalOpen} onOpenChange={setFlowModalOpen}>
        <Modal.Backdrop className="z-[140] bg-black/75" variant="blur">
          <Modal.Container className="p-3" placement="center" scroll="inside" size="sm">
            <Modal.Dialog className="overflow-hidden border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70">
              <Modal.CloseTrigger aria-label="Close Codespace connection dialog" />
              <Modal.Header className="block border-b border-neutral-800 px-5 py-4 pr-12">
                <Modal.Heading className="text-base font-semibold">
                  {modalKind === 'github'
                    ? 'Connect GitHub'
                    : modalKind === 'codex'
                      ? 'Sign in to Codex'
                      : modalKind === 'connector'
                        ? 'Approve Codespace connector'
                        : 'Restore Codespace connection'}
                </Modal.Heading>
                <p className="mt-1 text-xs leading-5 text-neutral-400">
                  {modalKind === 'github'
                    ? 'Authorize Project Space to inspect and prepare this Codespace.'
                    : modalKind === 'codex'
                      ? 'Use your ChatGPT subscription. No API key is required.'
                      : flowFailure?.message ?? runner?.message}
                </p>
              </Modal.Header>
              <Modal.Body className="grid gap-4 px-5 py-5">
                {modalKind === 'github' && githubFlow ? (
                  <>
                    <span className="text-xs text-neutral-400">Enter this one-time code on GitHub:</span>
                    <code className="rounded-xl bg-neutral-900 px-4 py-3 text-center font-mono text-xl font-semibold tracking-[0.22em] text-neutral-50">{githubFlow.userCode}</code>
                  </>
                ) : modalKind === 'codex' && authorization ? (
                  <>
                    <span className="text-xs text-neutral-400">Enter this one-time code on ChatGPT:</span>
                    <code className="rounded-xl bg-neutral-900 px-4 py-3 text-center font-mono text-xl font-semibold tracking-[0.22em] text-neutral-50">{authorization.userCode}</code>
                  </>
                ) : modalKind === 'connector' ? (
                  <p className="text-sm leading-6 text-neutral-300">GitHub requires approval before the Project Space connector can run in this Codespace.</p>
                ) : (
                  <p className="text-sm leading-6 text-neutral-300">Retry the status check. Existing task and Codespace state will be preserved.</p>
                )}
              </Modal.Body>
              <Modal.Footer className="flex-wrap border-t border-neutral-800 px-5 py-4">
                {modalKind === 'github' && githubFlow ? (
                  <>
                    <Button size="sm" variant="ghost" onPress={() => void navigator.clipboard.writeText(githubFlow.userCode ?? '')}><Copy className="size-3.5" /> Copy code</Button>
                    {githubFlow.verificationUri ? <a href={githubFlow.verificationUri} rel="noreferrer" target="_blank"><Button size="sm" variant="secondary">Open GitHub <ExternalLink className="size-3.5" /></Button></a> : null}
                    <Button isDisabled={Boolean(busy)} size="sm" variant="primary" onPress={() => void checkGitHubLogin()}>Check login</Button>
                  </>
                ) : modalKind === 'codex' && authorization ? (
                  <>
                    <Button size="sm" variant="ghost" onPress={() => void navigator.clipboard.writeText(authorization.userCode ?? '')}><Copy className="size-3.5" /> Copy code</Button>
                    {authorization.verificationUrl ? <a href={authorization.verificationUrl} rel="noreferrer" target="_blank"><Button size="sm" variant="secondary">Open ChatGPT <ExternalLink className="size-3.5" /></Button></a> : null}
                    <Button size="sm" variant="ghost" onPress={() => void authorizeCodex('cancel')}>Cancel sign in</Button>
                  </>
                ) : modalKind === 'connector' && runner?.approvalUrl ? (
                  <a href={runner.approvalUrl} rel="noreferrer" target="_blank"><Button size="sm" variant="primary">Open approval <ExternalLink className="size-3.5" /></Button></a>
                ) : modalKind === 'connection' ? (
                  <Button
                    isDisabled={Boolean(busy)}
                    size="sm"
                    variant="primary"
                    onPress={() => flowFailure?.retry === 'github'
                      ? void startGitHubLogin()
                      : flowFailure?.retry === 'codex'
                        ? void authorizeCodex('start')
                        : void run('status')}
                  >
                    <RefreshCw className="size-3.5" /> Retry connection
                  </Button>
                ) : null}
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
