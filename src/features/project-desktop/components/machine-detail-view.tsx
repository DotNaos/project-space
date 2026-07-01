import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConnectorOverviewResult,
  MachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { refreshProjectSpaceAuthToken } from '@/api/project-space-client';
import { Button, Surface, Text } from '@/app/dotnaos-ui';
import { Terminal as TerminalIcon } from 'lucide-react';
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';
import {
  isMachineConnected,
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';
import {
  formatOptionalTime,
  getProjectMachineId,
  isVisibleProject,
  machineSubtitle
} from './project-main-model';

function MachineDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 border-b border-neutral-900/70 py-2 last:border-b-0">
      <Text className="shrink-0 text-xs font-medium text-neutral-500">{label}</Text>
      <Text className="min-w-0 truncate text-right text-sm text-neutral-200">{value}</Text>
    </div>
  );
}

type MachineTerminalStatus = 'connecting' | 'connected' | 'closed' | 'error';

const MachineTerminalSession = memo(function MachineTerminalSession({
  canRun,
  machineId,
  onStatusChange,
  sessionVersion
}: {
  canRun: boolean;
  machineId: string;
  onStatusChange(status: MachineTerminalStatus, message?: string): void;
  sessionVersion: number;
}) {
  const terminalElementRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<WTerm | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sizeRef = useRef({ cols: 100, rows: 28 });

  useEffect(() => {
    const element = terminalElementRef.current;

    if (!element) {
      return;
    }

    let canceled = false;
    const terminal = new WTerm(element, {
      autoResize: true,
      cols: 100,
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
      rows: 28
    });
    terminalRef.current = terminal;

    terminal
      .init()
      .then(async () => {
        if (canceled) {
          return;
        }

        if (!canRun) {
          onStatusChange('closed');
          return;
        }

        const { cols, rows } = sizeRef.current;
        const baseUrl =
          import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL ||
          new URL(window.location.href).searchParams.get('projectSpaceApi') ||
          window.location.origin;
        const url = new URL(`/api/machines/${encodeURIComponent(machineId)}/terminal`, baseUrl);
        const sessionToken = await refreshProjectSpaceAuthToken();

        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('cols', String(cols));
        url.searchParams.set('rows', String(rows));
        if (sessionToken) {
          url.searchParams.set('session', sessionToken);
        }
        const socket = new WebSocket(url);
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
  }, [canRun, machineId, onStatusChange, sessionVersion]);

  return <div ref={terminalElementRef} className="project-machine-terminal h-[28rem] w-full" />;
}, (previous, next) => {
  return (
    previous.canRun === next.canRun &&
    previous.machineId === next.machineId &&
    previous.sessionVersion === next.sessionVersion
  );
});

function MachineTerminalPanel({ machine }: { machine: MachineRecord }) {
  const [sessionVersion, setSessionVersion] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [status, setStatus] = useState<MachineTerminalStatus>('closed');
  const canRun = isMachineConnected(machine);
  const handleStatusChange = useCallback((nextStatus: MachineTerminalStatus, message?: string) => {
    setErrorMessage(message ?? '');
    setStatus(nextStatus);
  }, []);

  function reconnect() {
    setSessionVersion((current) => current + 1);
  }

  return (
    <Surface
      variant="tertiary"
      className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TerminalIcon className="size-4 text-neutral-400" />
          <Text className="text-sm font-semibold text-neutral-100">Terminal</Text>
        </div>
        <Button size="sm" isDisabled={!canRun || status === 'connecting'} onPress={reconnect}>
          {status === 'connected' ? 'Reconnect' : 'Connect'}
        </Button>
      </div>

      {!canRun ? (
        <Text className="block text-xs text-neutral-500">
          This machine is not connected, so no shell is available right now.
        </Text>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-neutral-800 bg-black">
        <MachineTerminalSession
          canRun={canRun}
          machineId={machine.id}
          onStatusChange={handleStatusChange}
          sessionVersion={sessionVersion}
        />
      </div>
      <Text className="mt-2 block text-xs text-neutral-600">
        {status === 'connected'
          ? 'Live shell connected.'
          : status === 'connecting'
            ? 'Connecting shell...'
            : status === 'error'
              ? errorMessage || 'Terminal connection failed.'
              : 'Terminal disconnected.'}
      </Text>
    </Surface>
  );
}

export function MachineDetailView({
  connector,
  machine,
  machineId,
  onOpenMachines,
  onSelectProject,
  projects
}: {
  connector: ConnectorOverviewResult;
  machine?: MachineRecord;
  machineId: string;
  onOpenMachines(): void;
  onSelectProject(projectId: string): void;
  projects: ProjectSpaceRecord[];
}) {
  const localMachineId =
    connector.machines.find((entry) => entry.connector.status === 'local')?.id ??
    connector.machines[0]?.id ??
    'local';
  const machineProjects = machine
    ? projects
        .filter(isVisibleProject)
        .filter((project) => project.kind !== 'github')
        .filter((project) => getProjectMachineId(project, localMachineId) === machine.id)
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];

  if (!machine) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-4">
        <Text className="block text-2xl font-semibold text-neutral-100">Machine not found</Text>
        <Text className="block text-sm text-neutral-500">
          {machineId || 'This machine'} is not currently in the connector registry.
        </Text>
        <Button className="w-fit" variant="secondary" onPress={onOpenMachines}>
          Back to machines
        </Button>
      </div>
    );
  }

  const origin =
    machine.connector.origin ?? machine.network.tailscaleIp ?? machine.connector.installCommand;

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-5">
      <section className="border-b border-neutral-800/70 pb-5">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <MachineDeviceIcon machine={machine} />
              <Text className="truncate text-2xl font-semibold text-neutral-50">
                {machine.name}
              </Text>
              <MachineOsMark machine={machine} />
            </div>
            <Text className="mt-1 block text-sm text-neutral-500">
              {machineSubtitle(machine) || 'machine'}
            </Text>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <MachineConnectionIcon machine={machine} />
            <MachineBatteryMeter machine={machine} />
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Surface
          variant="tertiary"
          className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <Text className="mb-3 block text-sm font-semibold text-neutral-100">Connection</Text>
          <MachineDetailRow label="Status" value={machine.connector.status} />
          <MachineDetailRow label="Service" value={machine.connector.serviceName ?? 'unknown'} />
          <MachineDetailRow label="Last seen" value={formatOptionalTime(machine.connector.lastSeen)} />
          <MachineDetailRow label="Origin" value={origin ?? 'unknown'} />
        </Surface>

        <Surface
          variant="tertiary"
          className="rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
        >
          <Text className="mb-3 block text-sm font-semibold text-neutral-100">System</Text>
          <MachineDetailRow label="OS" value={[machine.os?.family, machine.os?.version].filter(Boolean).join(' ') || 'unknown'} />
          <MachineDetailRow label="Device" value={machine.kind || 'unknown'} />
          <MachineDetailRow label="Profile" value={machine.profile ?? 'unknown'} />
          <MachineDetailRow label="User" value={machine.primaryUser ?? machine.network.sshUser ?? 'unknown'} />
        </Surface>
      </section>

      <MachineTerminalPanel machine={machine} />

      <section>
        <div className="mb-2 flex items-center justify-between gap-3">
          <Text className="text-sm font-semibold text-neutral-100">Projects on this machine</Text>
          <Text className="text-xs text-neutral-500">{machineProjects.length}</Text>
        </div>

        {machineProjects.length > 0 ? (
          <div className="flex flex-col divide-y divide-neutral-900/80">
            {machineProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                title={project.rootPath}
                onClick={() => onSelectProject(project.id)}
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition hover:bg-neutral-900/50"
              >
                <span className="min-w-0">
                  <Text className="block truncate text-sm font-medium text-neutral-100">
                    {project.name}
                  </Text>
                  <Text className="block truncate font-mono text-xs text-neutral-500">
                    {project.rootPath}
                  </Text>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-lg bg-neutral-950/45 px-4 py-6">
            <Text className="text-sm text-neutral-500">
              No local projects reported by this machine yet.
            </Text>
          </div>
        )}
      </section>
    </div>
  );
}
