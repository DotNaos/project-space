import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, RefreshCw, SquareTerminal } from 'lucide-react';
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';
import { Button, Chip, Surface, Text } from '@/app/dotnaos-ui';
import {
  isProjectSpaceApiRequestAllowed,
  projectSpaceClient,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from '@/api/project-space-client';
import type {
  CodexStatusResult,
  OpenPathInAppResult
} from '@/shared/project-space-api';

interface ProjectWorkspaceToolsProps {
  targetPath: string;
}

type ProjectTerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';

function formatOpenResult(result?: OpenPathInAppResult) {
  if (!result) {
    return '';
  }

  return result.status === 'success' ? 'Codex opened for this target.' : result.message ?? 'Could not open Codex.';
}

function CodexStatusRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid min-w-0 grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 border-b border-neutral-900/80 py-2 last:border-b-0">
      <Text className="text-xs uppercase tracking-[0.14em] text-neutral-500">{label}</Text>
      <Text className="truncate text-sm text-neutral-200">{value || 'Not found'}</Text>
    </div>
  );
}

function terminalBaseUrl() {
  const currentUrl = new URL(window.location.href);
  return (
    resolveProjectSpaceApiBaseUrl(
      currentUrl.toString(),
      import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL
    ) || currentUrl.origin
  );
}

const ProjectTerminalSession = memo(function ProjectTerminalSession({
  onStatusChange,
  sessionVersion,
  targetPath
}: {
  onStatusChange(status: ProjectTerminalStatus, message?: string): void;
  sessionVersion: number;
  targetPath: string;
}) {
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<WTerm | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ cols: 112, rows: 34 });

  useEffect(() => {
    const element = terminalElementRef.current;

    if (!element) {
      return;
    }

    let canceled = false;
    const terminal = new WTerm(element, {
      autoResize: true,
      cols: 112,
      cursorBlink: true,
      onData(data) {
        const socket = socketRef.current;

        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ data, type: 'input' }));
        }
      },
      onResize(cols, rows) {
        sizeRef.current = { cols, rows };
        const socket = socketRef.current;

        if (socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ cols, rows, type: 'resize' }));
        }
      },
      rows: 34
    });
    terminalRef.current = terminal;

    terminal
      .init()
      .then(async () => {
        if (canceled) {
          return;
        }

        const { cols, rows } = sizeRef.current;
        const url = new URL('/api/projects/terminal', terminalBaseUrl());
        if (!isProjectSpaceApiRequestAllowed(window.location.href, url.toString())) {
          throw new Error('Project Space refused a terminal connection to an untrusted origin.');
        }
        const sessionToken = await refreshProjectSpaceAuthToken();

        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('cwd', targetPath);
        url.searchParams.set('cols', String(cols));
        url.searchParams.set('rows', String(rows));
        const protocols = sessionToken
          ? ['project-space', `project-space-auth.${sessionToken}`]
          : ['project-space'];
        const socket = new WebSocket(url, protocols);
        socketRef.current = socket;

        onStatusChange('connecting');
        terminal.write('\x1bc');

        socket.addEventListener('open', () => {
          if (canceled) {
            return;
          }

          onStatusChange('connected');
          terminal.focus();
        });

        socket.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data)) as {
              data?: string;
              exitCode?: number;
              signal?: number;
              type: 'output' | 'exit';
            };

            if (message.type === 'output' && typeof message.data === 'string') {
              terminal.write(message.data);
              return;
            }

            if (message.type === 'exit') {
              terminal.write(
                `\r\n[session exited: ${message.exitCode ?? message.signal ?? 'closed'}]\r\n`
              );
            }
          } catch {
            terminal.write(String(event.data));
          }
        });

        socket.addEventListener('close', () => {
          if (socketRef.current === socket) {
            socketRef.current = null;
          }

          if (!canceled) {
            onStatusChange('closed');
          }
        });

        socket.addEventListener('error', () => {
          if (!canceled) {
            onStatusChange('error');
            terminal.write('\r\n[terminal connection failed]\r\n');
          }
        });
      })
      .catch((error) => {
        if (canceled) {
          return;
        }

        onStatusChange(
          'error',
          `wterm failed to initialize: ${
            error instanceof Error ? error.message : 'unknown error'
          }`
        );
      });

    return () => {
      canceled = true;
      socketRef.current?.close();
      socketRef.current = null;
      terminal.destroy();
      if (terminalRef.current === terminal) {
        terminalRef.current = null;
      }
      onStatusChange('closed');
    };
  }, [onStatusChange, sessionVersion, targetPath]);

  return <div ref={terminalElementRef} className="project-terminal h-full min-h-[34rem] w-full" />;
}, (previous, next) => {
  return (
    previous.sessionVersion === next.sessionVersion &&
    previous.targetPath === next.targetPath
  );
});

export function ProjectWorkspaceTools({ targetPath }: ProjectWorkspaceToolsProps) {
  const [sessionVersion, setSessionVersion] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [status, setStatus] = useState<ProjectTerminalStatus>('closed');
  const handleStatusChange = useCallback((nextStatus: ProjectTerminalStatus, message?: string) => {
    setErrorMessage(message ?? '');
    setStatus(nextStatus);
  }, []);

  function reconnect() {
    setSessionVersion((current) => current + 1);
  }

  return (
    <div className="flex min-h-[34rem] min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal className="size-4 shrink-0 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Terminal</Text>
          <Chip size="sm" className="max-w-[34rem] truncate font-mono text-neutral-500">
            {targetPath}
          </Chip>
        </div>
        <div className="flex items-center gap-2">
          <Chip size="sm" className="font-mono text-neutral-500">
            {status}
          </Chip>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!targetPath || status === 'connecting'}
            onPress={reconnect}
          >
            <RefreshCw className="size-4" />
            {status === 'connected' ? 'Reconnect' : 'Connect'}
          </Button>
        </div>
      </div>

      <Surface
        variant="tertiary"
        className="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-800 bg-black"
      >
        <ProjectTerminalSession
          onStatusChange={handleStatusChange}
          sessionVersion={sessionVersion}
          targetPath={targetPath}
        />
      </Surface>
      <Text className="text-xs text-neutral-600">
        {status === 'connected'
          ? 'Live shell connected.'
          : status === 'connecting'
            ? 'Connecting shell...'
            : status === 'error'
              ? errorMessage || 'Terminal connection failed.'
              : 'Terminal disconnected.'}
      </Text>
    </div>
  );
}

export function ProjectCodexPanel({ targetPath }: ProjectWorkspaceToolsProps) {
  const [status, setStatus] = useState<CodexStatusResult>();
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [openResult, setOpenResult] = useState<OpenPathInAppResult>();

  async function refresh() {
    setIsRefreshing(true);
    try {
      setStatus(await projectSpaceClient.getCodexStatus());
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const rows = useMemo<Array<[string, string | undefined]>>(
    () => [
      ['CLI', status?.cliAvailable ? status.cliPath : 'Not found'],
      ['App', status?.appInstalled ? status.appPath : 'Not found'],
      ['App server', status?.appServerOrigin ?? 'No server URL configured'],
      ['Skills', status?.skillsPath],
      ['Config', status?.configPath],
      ['Thread', status?.currentThreadId ?? 'No active thread id']
    ],
    [status]
  );

  async function openCodex() {
    setOpenResult(await projectSpaceClient.openCodexTarget({ cwd: targetPath }));
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 shrink-0 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Codex</Text>
          <Chip size="sm" className="max-w-[34rem] truncate font-mono text-neutral-500">
            {targetPath}
          </Chip>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" isDisabled={isRefreshing} onPress={() => void refresh()}>
            <RefreshCw className={isRefreshing ? 'size-4 animate-spin' : 'size-4'} />
            Refresh
          </Button>
          <Button size="sm" variant="secondary" isDisabled={!targetPath} onPress={() => void openCodex()}>
            <Bot className="size-4" />
            Open Codex
          </Button>
        </div>
      </div>

      <Surface variant="tertiary" className="rounded-lg border border-neutral-800 bg-black/20 px-4 py-3">
        <div className="mb-2 flex items-center gap-2">
          <CheckCircle2 className="size-4 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Runtime status</Text>
        </div>
        <div className="grid">
          {rows.map(([label, value]) => (
            <CodexStatusRow key={label} label={label} value={value} />
          ))}
        </div>
      </Surface>

      {formatOpenResult(openResult) ? (
        <Text className="text-sm text-neutral-400">{formatOpenResult(openResult)}</Text>
      ) : null}
    </div>
  );
}
