import { useEffect, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type { GitHubCodespaceRunnerResult } from '@/shared/github-codespace-runner-api';
import { createBrowserRandomUuid } from '@/shared/browser-random-uuid';
import { GitHubCodespaceActions } from './github-codespace-actions';
import { codespaceStatusPresentation } from './github-codespace-picker';

interface GitHubCodespaceTaskControlsProps {
  branch: string;
  codespaceName: string;
  issue: number;
  repositoryFullName: string;
}

const transitionStates = new Set([
  'provisioning',
  'queued',
  'rebuilding',
  'shuttingdown',
  'starting',
  'stopping'
]);

function operationId() {
  return `codespace:${createBrowserRandomUuid()}`;
}

export function GitHubCodespaceTaskControls({
  branch,
  codespaceName,
  issue,
  repositoryFullName
}: GitHubCodespaceTaskControlsProps) {
  const [runner, setRunner] = useState<GitHubCodespaceRunnerResult>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const statusOperation = useRef(operationId());
  const pollInFlight = useRef(false);

  async function run(action: 'delete' | 'start' | 'status' | 'stop', silent = false) {
    if (!silent) {
      setBusy(action);
      setError('');
    }
    try {
      const next = await projectSpaceClient.runGitHubCodespace({
        action,
        branch,
        codespaceName,
        issue,
        operationId: action === 'status' ? statusOperation.current : operationId(),
        repositoryFullName
      });
      setRunner(next);
      if (silent) setError('');
    } catch (cause) {
      if (!silent) {
        setError(cause instanceof Error ? cause.message : 'The Codespace could not be updated.');
      }
    } finally {
      if (!silent) setBusy('');
    }
  }

  async function poll() {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    try {
      await run('status', true);
    } finally {
      pollInFlight.current = false;
    }
  }

  useEffect(() => {
    statusOperation.current = operationId();
    setRunner(undefined);
    setError('');
    void run('status');
  }, [branch, codespaceName, issue, repositoryFullName]);

  useEffect(() => {
    const state = runner?.codespace?.state.toLowerCase();
    const interval = transitionStates.has(state ?? '') ? 4_000 : 15_000;
    const timer = window.setInterval(() => void poll(), interval);
    return () => window.clearInterval(timer);
  }, [runner?.codespace?.state]);

  if (!runner?.codespace) {
    return busy === 'status' ? (
      <span className="inline-flex items-center gap-1.5 text-[10px] text-current/35">
        <LoaderCircle className="size-3 animate-spin" /> Checking Codespace…
      </span>
    ) : null;
  }

  const status = codespaceStatusPresentation(runner.codespace.state);
  return (
    <div className="grid gap-2 border-t border-current/[.07] pt-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <span className={`inline-flex items-center gap-2 text-[10px] ${status.textClassName}`}>
        <span className={`size-2 rounded-full ${status.dotClassName}`} />
        Codespace {status.label}
      </span>
      <GitHubCodespaceActions
        busy={busy}
        className="w-full sm:w-64"
        state={runner.codespace.state}
        onDelete={() => void run('delete')}
        onStart={() => void run('start')}
        onStop={() => void run('stop')}
      />
      {error ? <p className="text-[10px] text-amber-300 sm:col-span-2">{error}</p> : null}
    </div>
  );
}
