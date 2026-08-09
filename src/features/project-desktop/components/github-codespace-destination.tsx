import { useEffect, useRef, useState } from 'react';
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
import type { GitHubCodespaceRunnerResult } from '@/shared/github-codespace-runner-api';
import type { GitHubOAuthDeviceStartResult } from '@/shared/project-space-api';

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
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const statusOperation = useRef(operation('codespace'));
  const authorizationOperation = useRef('');
  const runnerPollInFlight = useRef(false);
  const authorizationPollInFlight = useRef(false);

  async function run(action: 'delete' | 'provision' | 'start' | 'status' | 'stop') {
    setBusy(action);
    setError('');
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
      setError(cause instanceof Error ? cause.message : 'The Codespace could not be updated.');
    } finally {
      setBusy('');
    }
  }

  async function startGitHubLogin() {
    setBusy('github-login');
    setError('');
    try {
      setGitHubFlow(await projectSpaceClient.startGitHubOAuthDeviceFlow());
    } finally {
      setBusy('');
    }
  }

  async function checkGitHubLogin() {
    if (!githubFlow?.deviceCode) return;
    setBusy('github-login');
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
      setError(cause instanceof Error ? cause.message : 'Codex authorization failed safely.');
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
    if (!runner || !['provisioning', 'connector-approval-required'].includes(runner.state)) return;
    const timer = window.setInterval(() => void pollRunner(), 4_000);
    return () => window.clearInterval(timer);
  }, [runner?.state]);

  useEffect(() => {
    if (authorization?.state !== 'pending') return;
    const timer = window.setInterval(() => void pollAuthorization(), 3_000);
    return () => window.clearInterval(timer);
  }, [authorization?.state, runner?.connectorId, runner?.environmentId]);

  const online = runner?.state === 'ready' || runner?.state === 'authorization-required';
  const pending = busy !== '' || runner?.state === 'provisioning';
  const name = runner?.codespace?.name ?? 'New task Codespace';

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
          <Button isDisabled={Boolean(busy) || githubFlow?.status === 'pending'} size="sm" variant="ghost" onPress={() => void startGitHubLogin()}>
            <RefreshCw className="size-3.5" /> {githubFlow?.status === 'pending' ? 'Waiting for GitHub' : 'Reconnect GitHub'}
          </Button>
        ) : runner?.state === 'connector-approval-required' && runner.approvalUrl ? (
          <a href={runner.approvalUrl} rel="noreferrer" target="_blank">
            <Button size="sm" variant="ghost">Approve <ExternalLink className="size-3.5" /></Button>
          </a>
        ) : runner?.state === 'authorization-required' ? (
          <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => void authorizeCodex('start')}>
            <Bot className="size-3.5" /> Sign in to Codex
          </Button>
        ) : runner?.state === 'offline' ? (
          <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => void run('start')}>
            Start Codespace
          </Button>
        ) : runner?.state === 'ready' && runner.connectorId && runner.environmentId ? (
          <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => onStart({
            connectorId: runner.connectorId!,
            environmentId: runner.environmentId!,
            name
          })}>
            <Bot className="size-3.5" /> Start Codex
          </Button>
        ) : null}
      </div>

      <p className="px-3 text-[11px] leading-5 text-current/40">
        {runner?.message ?? 'Checking GitHub Codespaces…'}
      </p>

      {githubFlow?.status === 'pending' ? (
        <div className="grid gap-2 border-l-2 border-sky-400/40 py-1 pl-3 text-xs">
          <span className="text-current/55">Enter this one-time GitHub code:</span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-base font-semibold tracking-wider text-current/85">{githubFlow.userCode}</code>
            <Button size="sm" variant="ghost" onPress={() => void navigator.clipboard.writeText(githubFlow.userCode ?? '')}><Copy className="size-3.5" /> Copy</Button>
            {githubFlow.verificationUri ? <a href={githubFlow.verificationUri} rel="noreferrer" target="_blank"><Button size="sm" variant="ghost">Open GitHub <ExternalLink className="size-3.5" /></Button></a> : null}
            <Button isDisabled={Boolean(busy)} size="sm" variant="ghost" onPress={() => void checkGitHubLogin()}>Check login</Button>
          </div>
        </div>
      ) : null}

      {authorization?.state === 'pending' ? (
        <div className="grid gap-2 border-l-2 border-emerald-400/40 py-1 pl-3 text-xs">
          <span className="text-current/55">Sign in with your ChatGPT subscription. No API key is used.</span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-base font-semibold tracking-wider text-current/85">{authorization.userCode}</code>
            <Button size="sm" variant="ghost" onPress={() => void navigator.clipboard.writeText(authorization.userCode ?? '')}><Copy className="size-3.5" /> Copy</Button>
            {authorization.verificationUrl ? <a href={authorization.verificationUrl} rel="noreferrer" target="_blank"><Button size="sm" variant="ghost">Open ChatGPT <ExternalLink className="size-3.5" /></Button></a> : null}
            <Button size="sm" variant="ghost" onPress={() => void authorizeCodex('cancel')}>Cancel</Button>
          </div>
        </div>
      ) : null}

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
    </div>
  );
}
