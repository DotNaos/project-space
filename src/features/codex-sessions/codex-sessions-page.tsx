import { useMemo, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type {
  CodexSessionBrowserResult,
  CodexSessionReadRequest
} from '@/shared/codex-sessions-api';
import { CodexSessionList } from './codex-session-list';
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
  conversations?: CodexConversation[];
  errorMessage?: string;
  machines: CodexMachine[];
  now?: Date;
  onContinueThread?(origin: CodexThreadOrigin, message: string): Promise<void> | void;
  onBackFromThread?(): void;
  onInterruptThread?(origin: CodexThreadOrigin, turnId: string): Promise<void> | void;
  onOpenProjectChatThread?(origin: CodexThreadOrigin): void;
  onResolveApproval?(decision: CodexApprovalDecision): Promise<void> | void;
  onResolveUserInput?(decision: CodexUserInputDecision): Promise<void> | void;
  onSelectThread?(origin: CodexThreadOrigin): void;
  readBrowser?(request: CodexSessionReadRequest): Promise<CodexSessionBrowserResult>;
  selectedOrigin?: CodexThreadOrigin;
  sessions: CodexSession[];
}

function sameOrigin(session: CodexSession, origin?: CodexThreadOrigin) {
  return session.machineId === origin?.machineId && session.threadId === origin.threadId;
}

export function CodexSessionsPage({
  activeTurnId,
  conversations = [],
  errorMessage,
  machines,
  now = new Date(),
  onContinueThread,
  onBackFromThread,
  onInterruptThread,
  onResolveApproval,
  onResolveUserInput,
  onSelectThread,
  readBrowser,
  selectedOrigin,
  sessions
}: CodexSessionsPageProps) {
  const [query, setQuery] = useState('');
  const selectedSession = sessions.find((session) => sameOrigin(session, selectedOrigin));
  const selectedMachine = machines.find((machine) => machine.id === selectedSession?.machineId);
  const selectedConversation = conversations.find((conversation) => (
    conversation.machineId === selectedSession?.machineId
    && conversation.threadId === selectedSession?.threadId
  ));

  const listPane = useMemo(() => (
    <CodexSessionList
      machines={machines}
      now={now}
      onSelect={(session) => {
        onSelectThread?.({ machineId: session.machineId, threadId: session.threadId });
      }}
      query={query}
      selectedOrigin={selectedOrigin}
      sessions={sessions}
      setQuery={setQuery}
    />
  ), [machines, now, onSelectThread, query, selectedOrigin, sessions]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-neutral-950 text-neutral-100">
      {errorMessage ? (
        <div className="absolute left-1/2 top-[76px] z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-red-500/20 bg-neutral-950/95 px-3 py-2 text-[10px] leading-4 text-red-200 shadow-xl min-[1120px]:top-3 min-[1120px]:rounded-full">
          <CircleAlert className="size-3.5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      ) : null}
      {selectedSession && readBrowser ? (
        <CodexTaskWorkspace
          activeTurnId={activeTurnId}
          conversation={selectedConversation}
          loadBrowser={readBrowser}
          machine={selectedMachine}
          onBack={onBackFromThread}
          onContinue={onContinueThread}
          onInterrupt={onInterruptThread}
          onResolveApproval={onResolveApproval}
          onResolveUserInput={onResolveUserInput}
          session={selectedSession}
        />
      ) : (
        <div className="mx-auto h-full min-h-0 w-full max-w-4xl border-x border-neutral-800/60">
          {listPane}
        </div>
      )}
    </div>
  );
}
