import {
  type ComponentProps,
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import { Button, Drawer } from '@heroui/react';
import { Chat, ChatSidebar, type ChatAction, type ChatThreadData } from '@dotnaos/ui/chat';
import { Menu, X } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import { ProjectChatAgentAvatar } from '../project-chat/components/project-chat-agent-avatar';
import type { CodexHostInventoryItem } from '@/shared/codex-host-inventory-api';
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import { CodexTaskWorkspace } from './codex-task-workspace';
import { CodexThreadCreateDialog } from './codex-thread-create-dialog';
import type { CodexSessionsController } from './codex-sessions-controller';
import type { CodexThreadOrigin } from './codex-sessions-types';
import {
  buildCodexChatThreadSections,
  type CodexChatThreadSection,
  parseCodexChatThreadId
} from './project-codex-chat-model';
import { codexAgentIdentity } from './codex-agent-identity';

const hostRefreshIntervalMs = 30_000;
const sessionRefreshIntervalMs = 5_000;

type CompatibleChatSidebarProps = ComponentProps<typeof ChatSidebar> & {
  threadSections?: readonly CodexChatThreadSection[];
};

// The published package accepts a flat `threads` list. The linked UI worktree
// additionally understands grouped sections. Supplying both keeps CI and the
// review surface useful until the UI-library release lands.
const CompatibleChatSidebar = ChatSidebar as ComponentType<CompatibleChatSidebarProps>;

export function ProjectCodexChatPage({
  controller,
  initialOrigin,
  onOpenThread,
  project
}: {
  controller: CodexSessionsController;
  initialOrigin?: CodexThreadOrigin;
  onOpenThread?(origin: CodexThreadOrigin): void;
  project?: ProjectSpaceRecord;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const [hosts, setHosts] = useState<CodexHostInventoryItem[]>([]);
  const [hostError, setHostError] = useState('');
  const [hostsLoading, setHostsLoading] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const mounted = useRef(false);
  const machineIds = useMemo(() => hosts.map((host) => host.machineId), [hosts]);
  const machineKey = machineIds.join('\u0000');
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
    () => buildCodexChatThreadSections(hosts, state.sessions, state.selectedOrigin).map((section) => ({
      ...section,
      threads: section.threads.map((thread) => {
        const identity = codexAgentIdentity(thread.label);
        return {
          ...thread,
          avatar: <ProjectChatAgentAvatar category={identity.category} name={identity.name} size={28} />
        };
      })
    })),
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
    if (
      hostsLoading
      || !state.selectedOrigin
      || machineIds.includes(state.selectedOrigin.machineId)
    ) return;
    controller.clearSelection();
  }, [controller, hostsLoading, machineKey, state.selectedOrigin]);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    if (initialOrigin) void controller.select(initialOrigin);
    else controller.clearSelection();
  }, [controller, initialOrigin]);

  const selectThread = useCallback((thread: ChatThreadData) => {
    const origin = parseCodexChatThreadId(thread.id);
    if (!origin) return;
    setMobileSidebarOpen(false);
    void controller.select(origin);
    onOpenThread?.(origin);
  }, [controller, onOpenThread]);

  const selectSidebarAction = useCallback((action: ChatAction) => {
    if (action.id === 'new-codex-task') {
      setMobileSidebarOpen(false);
      setCreateDialogOpen(true);
    }
  }, []);

  const sidebar = (
    <div className="h-full min-h-0 [&>aside]:h-full [&>aside]:border-l [&>aside]:border-r-0">
      <CompatibleChatSidebar
        actions={[{ icon: 'plus', id: 'new-codex-task', label: 'New task' }]}
        onActionSelect={selectSidebarAction}
        onThreadSelect={selectThread}
        threads={sections.flatMap((section) => section.threads)}
        threadSections={sections}
        title="Codex tasks"
      />
    </div>
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 overflow-hidden bg-app-panel text-neutral-100">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-800 px-3 lg:hidden">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-neutral-100">Chat</p>
            <p className="truncate text-[10px] text-neutral-500">
              {hostsLoading ? 'Checking machines…' : `${hosts.length} online`}
            </p>
          </div>
          <Button
            aria-label="Open Codex tasks"
            className="ml-auto"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={() => setMobileSidebarOpen(true)}
          >
            <Menu className="size-4" />
          </Button>
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
              onContinue={async (origin, message, settings, imageAttachmentIds) => { await controller.continue(origin, message, settings, imageAttachmentIds); }}
              onInterrupt={async (origin, turnId) => { await controller.interrupt(origin, turnId); }}
              onPermissionChange={async (origin, permissionProfileId) => { await controller.updatePermissionProfile(origin, permissionProfileId); }}
              onResolveApproval={async (decision) => { await controller.resolveApproval(decision); }}
              onResolveUserInput={async (decision) => { await controller.resolveUserInput(decision); }}
              onRemoveImage={(machineId, attachmentId) => controller.removeImage(machineId, attachmentId)}
              onSteer={async (origin, message, imageAttachmentIds) => { await controller.steer(origin, message, imageAttachmentIds); }}
              onUploadImage={(machineId, file) => controller.uploadImage(machineId, file)}
              session={selectedSession}
            />
          ) : (
            <div className="h-full min-h-0 [&>section]:h-full [&>section]:rounded-none [&>section]:border-0">
              <Chat
                disabled
                emptyDescription={emptyDescription(hostsLoading, hosts.length)}
                emptyTitle="Choose a Codex task"
                inputValue=""
                messages={[]}
                onInputChange={() => undefined}
                onSubmit={() => undefined}
                placeholder="Choose a task to enable chat"
                title="Codex chat"
              />
            </div>
          )}
        </div>
      </div>

      <div className="hidden h-full min-h-0 w-[17rem] shrink-0 lg:block">{sidebar}</div>

      <Drawer.Backdrop isOpen={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <Drawer.Content className="w-[min(88vw,22rem)]" placement="right">
          <Drawer.Dialog className="h-dvh rounded-none border-l border-neutral-800 bg-app-panel p-0 outline-none">
            <Drawer.Header className="sr-only"><Drawer.Heading>Codex tasks</Drawer.Heading></Drawer.Header>
            <Drawer.CloseTrigger className="absolute right-3 top-3 z-10 grid size-9 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800">
              <X className="size-4" />
            </Drawer.CloseTrigger>
            <Drawer.Body className="h-full p-0">{sidebar}</Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>

      <CodexThreadCreateDialog
        controller={controller}
        isOpen={createDialogOpen}
        onCreated={(origin) => onOpenThread?.(origin)}
        onOpenChange={setCreateDialogOpen}
        project={project}
        suppliedHosts={hosts}
      />
    </section>
  );
}

function emptyDescription(
  loading: boolean,
  hostCount: number
) {
  if (loading) return 'Only fresh, online Tailscale machines appear in the task list.';
  if (hostCount === 0) return 'No Tailscale machine with available Codex tasks is online right now.';
  return 'Choose a task from the list on the right. The composer stays disabled until then.';
}
