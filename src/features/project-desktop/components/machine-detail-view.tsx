import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConnectorOverviewResult,
  MachineRecord,
  ProjectSpaceRecord,
  ProjectStructureViolationRecord
} from '@/shared/project-space-api';
import {
  isProjectSpaceApiRequestAllowed,
  refreshProjectSpaceAuthToken,
  resolveProjectSpaceApiBaseUrl
} from '@/api/project-space-client';
import { Button, Surface, Tab, TabIndicator, TabList, Tabs, Text } from '@/app/dotnaos-ui';
import { Files, FolderKanban, LayoutDashboard, Terminal as TerminalIcon } from 'lucide-react';
import type { MachineDetailTab } from '../hooks/use-project-desktop';
import { WTerm } from '@wterm/dom';
import '@wterm/dom/css';
import {
  isMachineConnected,
  MachineBatteryMeter,
  MachineConnectionIcon,
  MachineDeviceIcon,
  MachineOsMark
} from './machine-visuals';
import { formatOptionalTime, machineSubtitle } from './project-main-model';
import { MachineProjectsPanel } from './machine-projects-panel';
import { MachineExplorerPanel } from './machine-explorer-panel';
import { MachineConnectorActionsMenu } from './machine-connector-actions-menu';
import {
  runtimeStateLabel,
  runtimeVersionLabel
} from './machine-connector-runtime-model';
import { ConnectorChannelChip } from './connector-channel-chip';

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
          resolveProjectSpaceApiBaseUrl(
            window.location.href,
            import.meta.env.VITE_PROJECT_SPACE_API_BASE_URL
          ) || window.location.origin;
        const url = new URL(`/api/machines/${encodeURIComponent(machineId)}/terminal`, baseUrl);
        if (!isProjectSpaceApiRequestAllowed(window.location.href, url.toString())) {
          throw new Error('Project Space refused a terminal connection to an untrusted origin.');
        }
        const sessionToken = await refreshProjectSpaceAuthToken();

        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
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
      className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
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

const machineTabItems: Array<{
  icon: typeof LayoutDashboard;
  id: MachineDetailTab;
  label: string;
}> = [
  { icon: LayoutDashboard, id: 'overview', label: 'Overview' },
  { icon: FolderKanban, id: 'projects', label: 'Projects' },
  { icon: Files, id: 'explorer', label: 'Explorer' },
  { icon: TerminalIcon, id: 'terminal', label: 'Terminal' }
];

export function MachineDetailView({
  connector,
  machine,
  machineId,
  onOpenMachines,
  onSelectProject,
  onSelectTab,
  onRefreshProjectDiscovery,
  projects,
  structureViolations,
  tab
}: {
  connector: ConnectorOverviewResult;
  machine?: MachineRecord;
  machineId: string;
  onOpenMachines(): void;
  onSelectProject(projectId: string): void;
  onSelectTab(tab: MachineDetailTab): void;
  onRefreshProjectDiscovery(): Promise<unknown>;
  projects: ProjectSpaceRecord[];
  structureViolations: ProjectStructureViolationRecord[];
  tab: MachineDetailTab;
}) {
  const localMachineId =
    connector.machines.find((entry) => entry.connector.status === 'local')?.id ??
    connector.machines[0]?.id ??
    'local';

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
    <div className={`mx-auto flex min-h-full w-full flex-col gap-4 ${tab === 'explorer' ? 'max-w-[100rem]' : 'max-w-5xl'}`}>
      <section className="border-b border-neutral-800/70 pb-4">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <MachineDeviceIcon machine={machine} />
              <Text className="truncate text-2xl font-semibold text-neutral-50">
                {machine.name}
              </Text>
              <MachineOsMark machine={machine} />
              <ConnectorChannelChip machine={machine} />
            </div>
            <Text className="mt-1 block text-sm text-neutral-500">
              {machineSubtitle(machine) || 'machine'}
            </Text>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <MachineConnectionIcon machine={machine} />
            <MachineBatteryMeter machine={machine} />
            <MachineConnectorActionsMenu machine={machine} />
          </div>
        </div>
      </section>

      <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <Tabs
          selectedKey={tab}
          onSelectionChange={(key) => {
            const nextTab = machineTabItems.find((item) => item.id === key);

            if (nextTab) {
              onSelectTab(nextTab.id);
            }
          }}
        >
          <TabList className="inline-flex min-w-max gap-1 rounded-xl bg-neutral-900/60 p-1">
            {machineTabItems.map((item) => {
              const Icon = item.icon;

              return (
                <Tab key={item.id} id={item.id} className="min-h-8 gap-1.5 px-3 text-xs">
                  <Icon className="size-3.5" />
                  {item.label}
                  <TabIndicator />
                </Tab>
              );
            })}
          </TabList>
        </Tabs>
      </div>

      {tab === 'overview' ? (
        <section className="grid gap-4 lg:grid-cols-2">
          <Surface
            variant="tertiary"
            className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
          >
            <Text className="mb-3 block text-sm font-semibold text-neutral-100">Connection</Text>
            <MachineDetailRow label="Status" value={machine.connector.status} />
            <MachineDetailRow label="Version" value={runtimeVersionLabel(machine)} />
            <MachineDetailRow
              label="Update"
              value={runtimeStateLabel(machine.connector.update?.state)}
            />
            <MachineDetailRow label="Service" value={machine.connector.serviceName ?? 'unknown'} />
            <MachineDetailRow label="Last seen" value={formatOptionalTime(machine.connector.lastSeen)} />
            <MachineDetailRow label="Origin" value={origin ?? 'unknown'} />
          </Surface>

          <Surface
            variant="tertiary"
            className="min-w-0 rounded-lg border border-neutral-800 bg-neutral-950/45 p-4"
          >
            <Text className="mb-3 block text-sm font-semibold text-neutral-100">System</Text>
            <MachineDetailRow label="OS" value={[machine.os?.family, machine.os?.version].filter(Boolean).join(' ') || 'unknown'} />
            <MachineDetailRow label="Device" value={machine.kind || 'unknown'} />
            <MachineDetailRow label="Profile" value={machine.profile ?? 'unknown'} />
            <MachineDetailRow label="User" value={machine.primaryUser ?? machine.network.sshUser ?? 'unknown'} />
          </Surface>
        </section>
      ) : null}

      {tab === 'terminal' ? <MachineTerminalPanel machine={machine} /> : null}

      {tab === 'explorer' ? <MachineExplorerPanel key={machine.id} machine={machine} /> : null}

      {tab === 'projects' ? (
        <MachineProjectsPanel
          localMachineId={localMachineId}
          machine={machine}
          onRefreshProjectDiscovery={onRefreshProjectDiscovery}
          onSelectProject={onSelectProject}
          projects={projects}
          structureViolations={structureViolations}
        />
      ) : null}
    </div>
  );
}
