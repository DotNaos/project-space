import { useMemo, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type {
  CodexSessionBrowserResult,
  CodexSessionReadRequest,
  CodexSessionTurnSettings
} from '@/shared/codex-sessions-api';
import type {
  ConnectorInstallationRecord,
  PhysicalMachineRecord,
  ProjectSpaceRecord
} from '@/shared/project-space-api';
import { CodexSessionList } from './codex-session-list';
import {
  ALL_CODEX_CONNECTORS,
  ALL_CODEX_MACHINES
} from './codex-session-list-model';
import { connectorLocationPresentation } from '../project-desktop/components/machine-connector-topology-model';
import { CodexTaskWorkspace } from './codex-task-workspace';
import type {
  CodexApprovalDecision,
  CodexConversation,
  CodexMachine,
  CodexSession,
  CodexThreadOrigin,
  CodexUserInputDecision
} from './codex-sessions-types';

export interface CodexSessionsPageProps {
  activeTurnId?: string;
  connectorInstallations?: ConnectorInstallationRecord[];
  conversations?: CodexConversation[];
  errorMessage?: string;
  loadingMachineIds?: string[];
  machines: CodexMachine[];
  now?: Date;
  onContinueThread?(
    origin: CodexThreadOrigin,
    message: string,
    settings?: CodexSessionTurnSettings
  ): Promise<void> | void;
  onBackFromThread?(): void;
  onInterruptThread?(origin: CodexThreadOrigin, turnId: string): Promise<void> | void;
  onOpenProjectChatThread?(origin: CodexThreadOrigin): void;
  onResolveApproval?(decision: CodexApprovalDecision): Promise<void> | void;
  onResolveUserInput?(decision: CodexUserInputDecision): Promise<void> | void;
  onSelectThread?(origin: CodexThreadOrigin): void;
  reading?: boolean;
  readBrowser?(request: CodexSessionReadRequest): Promise<CodexSessionBrowserResult>;
  physicalMachines?: PhysicalMachineRecord[];
  projects?: ProjectSpaceRecord[];
  selectedOrigin?: CodexThreadOrigin;
  sessions: CodexSession[];
}

function sameOrigin(session: CodexSession, origin?: CodexThreadOrigin) {
  return session.machineId === origin?.machineId && session.threadId === origin.threadId;
}

export function CodexSessionsPage({
  activeTurnId,
  connectorInstallations = [],
  conversations = [],
  errorMessage,
  loadingMachineIds = [],
  machines,
  now = new Date(),
  onContinueThread,
  onBackFromThread,
  onInterruptThread,
  onResolveApproval,
  onResolveUserInput,
  onSelectThread,
  physicalMachines = [],
  projects = [],
  reading = false,
  readBrowser,
  selectedOrigin,
  sessions
}: CodexSessionsPageProps) {
  const [query, setQuery] = useState('');
  const [selectedMachineKey, setSelectedMachineKey] = useState(ALL_CODEX_MACHINES);
  const [selectedConnectorKey, setSelectedConnectorKey] = useState(ALL_CODEX_CONNECTORS);
  const selectedSession = sessions.find((session) => sameOrigin(session, selectedOrigin));
  const selectedMachine = machines.find((machine) => machine.id === selectedSession?.machineId);
  const selectedConnector = connectorInstallations.find((connector) => (
    connector.id === selectedSession?.machineId
  ));
  const selectedLocation = selectedConnector ? connectorLocationPresentation({
    connector: selectedConnector,
    physicalMachines
  }) : undefined;
  const selectedConversation = conversations.find((conversation) => (
    conversation.machineId === selectedSession?.machineId
    && conversation.threadId === selectedSession?.threadId
  ));
  const historyState = reading
    ? 'loading' as const
    : selectedSession && ['missing', 'offline', 'unavailable'].includes(selectedSession.status)
      ? 'blocked' as const
      : selectedConversation
        ? 'ready' as const
        : 'loading' as const;

  const listPane = useMemo(() => (
    <CodexSessionList
      connectorInstallations={connectorInstallations}
      loadingMachineIds={loadingMachineIds}
      machines={machines}
      now={now}
      onSelect={(session) => {
        onSelectThread?.({ machineId: session.machineId, threadId: session.threadId });
      }}
      onSelectConnector={setSelectedConnectorKey}
      onSelectMachine={setSelectedMachineKey}
      physicalMachines={physicalMachines}
      projects={projects}
      query={query}
      selectedConnectorKey={selectedConnectorKey}
      selectedMachineKey={selectedMachineKey}
      selectedOrigin={selectedOrigin}
      sessions={sessions}
      setQuery={setQuery}
    />
  ), [
    connectorInstallations,
    loadingMachineIds,
    machines,
    now,
    onSelectThread,
    physicalMachines,
    projects,
    query,
    selectedConnectorKey,
    selectedMachineKey,
    selectedOrigin,
    sessions
  ]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-neutral-950 text-neutral-100">
      {errorMessage ? (
        <div className="absolute left-1/2 top-[76px] z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-red-500/20 bg-neutral-950/95 px-3 py-2 text-[10px] leading-4 text-red-200 shadow-xl min-[1120px]:top-3 min-[1120px]:rounded-full">
          <CircleAlert className="size-3.5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      ) : null}
      {selectedSession && readBrowser ? (
        <div className="flex h-full min-h-0 min-w-0">
          <aside className="hidden h-full min-h-0 w-[22rem] shrink-0 border-r border-neutral-800/80 min-[1320px]:block">
            {listPane}
          </aside>
          <div className="min-h-0 min-w-0 flex-1">
            <CodexTaskWorkspace
              activeTurnId={activeTurnId}
              conversation={selectedConversation}
              historyState={historyState}
              historyStatusDetail={selectedSession.statusDetail ?? selectedMachine?.statusDetail}
              loadBrowser={readBrowser}
              machine={selectedMachine}
              machineLabel={selectedLocation?.machineName}
              connectorLabel={selectedLocation?.connectorLabel}
              onBack={onBackFromThread}
              onContinue={onContinueThread}
              onInterrupt={onInterruptThread}
              onResolveApproval={onResolveApproval}
              onResolveUserInput={onResolveUserInput}
              session={selectedSession}
            />
          </div>
        </div>
      ) : (
        <div className="mx-auto h-full min-h-0 w-full max-w-5xl border-x border-neutral-800/60">
          {listPane}
        </div>
      )}
    </div>
  );
}
