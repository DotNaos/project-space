import type { Key } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Drawer, Label, ListBox, Select } from '@heroui/react';
import { Chat, ChatSidebar, type ChatThreadData } from '@dotnaos/ui/chat';
import { Menu, X } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type { CodexHostInventoryItem } from '@/shared/codex-host-inventory-api';
import { CodexTaskWorkspace } from './codex-task-workspace';
import type { CodexSessionsController } from './codex-sessions-controller';
import type { CodexThreadOrigin } from './codex-sessions-types';
import {
  buildCodexChatThreadSections,
  newestSessionForWorktree,
  parseCodexChatThreadId
} from './project-codex-chat-model';

const hostRefreshIntervalMs = 30_000;
const sessionRefreshIntervalMs = 5_000;

export function ProjectCodexChatPage({
  controller,
  initialOrigin,
  onOpenThread
}: {
  controller: CodexSessionsController;
  initialOrigin?: CodexThreadOrigin;
  onOpenThread?(origin: CodexThreadOrigin): void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [hosts, setHosts] = useState<CodexHostInventoryItem[]>([]);
  const [hostError, setHostError] = useState('');
  const [hostsLoading, setHostsLoading] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [selectedMachineId, setSelectedMachineId] = useState(initialOrigin?.machineId ?? '');
  const [selectedWorktreePath, setSelectedWorktreePath] = useState('');
  const mounted = useRef(false);
  const machineIds = useMemo(() => hosts.map((host) => host.machineId), [hosts]);
  const machineKey = machineIds.join('\u0000');
  const selectedHost = hosts.find((host) => host.machineId === selectedMachineId);
  const selectedSession = state.sessions.find((session) => (
    session.machineId === state.selectedOrigin?.machineId
    && session.threadId === state.selectedOrigin.threadId
  ));
  const selectedMachine = state.machines.find((machine) => machine.id === selectedSession?.machineId);
  const selectedConversation = state.conversations.find((conversation) => (
    conversation.machineId === selectedSession?.machineId
    && conversation.threadId === selectedSession?.threadId
  ));
  const historyState = state.reading
    ? 'loading' as const
    : selectedSession && ['missing', 'offline', 'unavailable'].includes(selectedSession.status)
      ? 'blocked' as const
      : selectedConversation
        ? 'ready' as const
        : 'loading' as const;
  const sections = useMemo(
    () => buildCodexChatThreadSections(hosts, state.sessions, state.selectedOrigin),
    [hosts, state.selectedOrigin, state.sessions]
  );

  useEffect(() => {
    let active = true;
    let loading = false;
    const refresh = async () => {
      if (loading || (typeof document !== 'undefined' && document.hidden)) return;
      loading = true;
      try {
        await projectSpaceClient.getTailscaleInventory(true);
        const result = await projectSpaceClient.getCodexHostInventory();
        if (!active) return;
        setHosts(result.hosts);
        setHostError('');
      } catch {
        if (active) {
          setHosts([]);
          setHostError('Online Codex machines are temporarily unavailable.');
        }
      } finally {
        loading = false;
        if (active) setHostsLoading(false);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), hostRefreshIntervalMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (machineIds.length === 0) return;
    let loading = false;
    const refresh = async () => {
      if (loading || (typeof document !== 'undefined' && document.hidden)) return;
      loading = true;
      try {
        await controller.loadMachines(machineIds);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), sessionRefreshIntervalMs);
    return () => {
      window.clearInterval(interval);
    };
  }, [controller, machineKey]);

  useEffect(() => {
    if (hostsLoading || !selectedMachineId || machineIds.includes(selectedMachineId)) return;
    setSelectedMachineId('');
    setSelectedWorktreePath('');
    controller.clearSelection();
  }, [controller, hostsLoading, machineKey, selectedMachineId]);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    if (initialOrigin) void controller.select(initialOrigin);
    else controller.clearSelection();
  }, [controller, initialOrigin]);

  useEffect(() => {
    if (!selectedMachineId || !selectedWorktreePath) return;
    const session = newestSessionForWorktree(state.sessions, selectedMachineId, selectedWorktreePath);
    if (!session) return;
    if (
      state.selectedOrigin?.machineId !== session.machineId
      || state.selectedOrigin.threadId !== session.threadId
    ) {
      void controller.select({ machineId: session.machineId, threadId: session.threadId });
    }
  }, [controller, selectedMachineId, selectedWorktreePath, state.selectedOrigin, state.sessions]);

  useEffect(() => {
    if (!initialOrigin || hosts.length === 0 || selectedWorktreePath) return;
    const session = state.sessions.find((entry) => (
      entry.machineId === initialOrigin.machineId && entry.threadId === initialOrigin.threadId
    ));
    if (session?.cwd) {
      setSelectedMachineId(session.machineId);
      setSelectedWorktreePath(session.cwd);
    }
  }, [hosts.length, initialOrigin, selectedWorktreePath, state.sessions]);

  const selectThread = useCallback((thread: ChatThreadData) => {
    const origin = parseCodexChatThreadId(thread.id);
    if (!origin) return;
    const session = state.sessions.find((entry) => (
      entry.machineId === origin.machineId && entry.threadId === origin.threadId
    ));
    setSelectedMachineId(origin.machineId);
    setSelectedWorktreePath(session?.cwd ?? '');
    setMobileSidebarOpen(false);
    void controller.select(origin);
    onOpenThread?.(origin);
  }, [controller, onOpenThread, state.sessions]);

  const sidebar = (
    <div className="h-full min-h-0 [&>aside]:h-full [&>aside]:border-neutral-800 [&>aside]:bg-neutral-950">
      <ChatSidebar
        onThreadSelect={selectThread}
        threadSections={sections}
        title="Codex tasks"
      />
    </div>
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 overflow-hidden bg-neutral-950 text-neutral-100">
      <div className="hidden h-full min-h-0 w-[17rem] shrink-0 lg:block">{sidebar}</div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 flex-wrap items-end gap-2 border-b border-neutral-800 px-3 py-2.5 sm:px-4">
          <Button
            aria-label="Open Codex tasks"
            className="mb-0.5 lg:hidden"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setMobileSidebarOpen(true)}
          >
            <Menu className="size-4" />
          </Button>
          <div className="mr-auto min-w-0 pb-1">
            <p className="truncate text-sm font-semibold text-neutral-100">Chat</p>
            <p className="truncate text-xs text-neutral-500">
              {hostsLoading ? 'Checking online machines…' : `${hosts.length} online ${hosts.length === 1 ? 'machine' : 'machines'}`}
            </p>
          </div>
          <MachineSelect
            hosts={hosts}
            value={selectedMachineId}
            onChange={(machineId) => {
              setSelectedMachineId(machineId);
              setSelectedWorktreePath('');
              controller.clearSelection();
            }}
          />
          <WorktreeSelect
            host={selectedHost}
            value={selectedWorktreePath}
            onChange={setSelectedWorktreePath}
          />
        </header>

        {hostError || state.errorMessage ? (
          <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-200" role="status">
            {hostError || state.errorMessage}
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          {selectedSession ? (
            <CodexTaskWorkspace
              activeTurnId={state.activeTurnId}
              conversation={selectedConversation}
              historyState={historyState}
              historyStatusDetail={selectedSession.statusDetail ?? selectedMachine?.statusDetail}
              loadBrowser={(origin) => controller.browser(origin)}
              machine={selectedMachine}
              onContinue={async (origin, message, settings) => { await controller.continue(origin, message, settings); }}
              onInterrupt={async (origin, turnId) => { await controller.interrupt(origin, turnId); }}
              onPermissionChange={async (origin, permissionProfileId) => { await controller.updatePermissionProfile(origin, permissionProfileId); }}
              onResolveApproval={async (decision) => { await controller.resolveApproval(decision); }}
              onResolveUserInput={async (decision) => { await controller.resolveUserInput(decision); }}
              onSteer={async (origin, message) => { await controller.steer(origin, message); }}
              session={selectedSession}
            />
          ) : (
            <div className="h-full min-h-0 [&>section]:h-full [&>section]:rounded-none [&>section]:border-0 [&>section]:bg-neutral-950">
              <Chat
                disabled
                emptyDescription={emptyDescription(hostsLoading, hosts.length, selectedMachineId, selectedWorktreePath)}
                emptyTitle="Choose where to continue"
                inputValue=""
                messages={[]}
                onInputChange={() => undefined}
                onSubmit={() => undefined}
                placeholder={selectedMachineId ? 'Select a worktree to enable chat' : 'Select a machine and worktree to enable chat'}
                title="Codex chat"
              />
            </div>
          )}
        </div>
      </div>

      <Drawer.Backdrop isOpen={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <Drawer.Content className="w-[min(88vw,22rem)]" placement="left">
          <Drawer.Dialog className="h-dvh rounded-none border-r border-neutral-800 bg-neutral-950 p-0 outline-none">
            <Drawer.Header className="sr-only"><Drawer.Heading>Codex tasks</Drawer.Heading></Drawer.Header>
            <Drawer.CloseTrigger className="absolute right-3 top-3 z-10 grid size-9 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800">
              <X className="size-4" />
            </Drawer.CloseTrigger>
            <Drawer.Body className="h-full p-0">{sidebar}</Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </section>
  );
}

function MachineSelect({
  hosts,
  onChange,
  value
}: {
  hosts: readonly CodexHostInventoryItem[];
  onChange(value: string): void;
  value: string;
}) {
  return (
    <Select className="w-[min(42vw,13rem)]" placeholder="Machine" value={value || null} onChange={(key) => onChange(String(key ?? ''))} variant="secondary">
      <Label className="sr-only">Machine</Label>
      <Select.Trigger className="min-h-9"><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover><ListBox>{hosts.map((host) => (
        <ListBox.Item id={host.machineId} key={host.machineId} textValue={host.name}>
          <span className="flex min-w-0 items-center gap-2"><span className="size-1.5 shrink-0 rounded-full bg-emerald-400" /><span className="truncate">{host.name}</span></span>
          <ListBox.ItemIndicator />
        </ListBox.Item>
      ))}</ListBox></Select.Popover>
    </Select>
  );
}

function WorktreeSelect({
  host,
  onChange,
  value
}: {
  host?: CodexHostInventoryItem;
  onChange(value: string): void;
  value: string;
}) {
  const worktrees = [...(host?.worktrees ?? [])];
  if (value && !worktrees.some((worktree) => worktree.path === value)) {
    worktrees.unshift({
      label: value.split('/').filter(Boolean).pop() ?? value,
      path: value,
      threadCount: 1
    });
  }
  return (
    <Select
      className="w-[min(42vw,15rem)]"
      isDisabled={!host}
      placeholder="Worktree"
      value={value || null}
      onChange={(key: Key | null) => onChange(String(key ?? ''))}
      variant="secondary"
    >
      <Label className="sr-only">Worktree</Label>
      <Select.Trigger className="min-h-9"><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover><ListBox>{worktrees.map((worktree) => (
        <ListBox.Item id={worktree.path} key={worktree.path} textValue={worktree.label}>
          <span className="min-w-0"><span className="block truncate">{worktree.label}</span><span className="block truncate text-xs text-neutral-500">{worktree.threadCount} tasks</span></span>
          <ListBox.ItemIndicator />
        </ListBox.Item>
      ))}</ListBox></Select.Popover>
    </Select>
  );
}

function emptyDescription(
  loading: boolean,
  hostCount: number,
  machineId: string,
  worktreePath: string
) {
  if (loading) return 'Only fresh, online Tailscale machines will appear here.';
  if (hostCount === 0) return 'No Tailscale machine with available Codex tasks is online right now.';
  if (!machineId) return 'Select an online machine, then choose one of its worktrees.';
  if (!worktreePath) return 'Choose a worktree. Its latest Codex task will open automatically.';
  return 'Loading the latest Codex task in this worktree…';
}
