import { useEffect, useMemo, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { CodexConversationPane } from './codex-conversation-pane';
import { CodexSessionDetails } from './codex-session-details';
import { CodexSessionList } from './codex-session-list';
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
  onInterruptThread?(origin: CodexThreadOrigin, turnId: string): Promise<void> | void;
  onOpenProjectChatThread?(origin: CodexThreadOrigin): void;
  onResolveApproval?(decision: CodexApprovalDecision): Promise<void> | void;
  onResolveUserInput?(decision: CodexUserInputDecision): Promise<void> | void;
  onSelectThread?(origin: CodexThreadOrigin): void;
  selectedOrigin?: CodexThreadOrigin;
  sessions: CodexSession[];
}

type CompactPane = 'conversation' | 'details' | 'list';

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
  onInterruptThread,
  onOpenProjectChatThread,
  onResolveApproval,
  onResolveUserInput,
  onSelectThread,
  selectedOrigin,
  sessions
}: CodexSessionsPageProps) {
  const [query, setQuery] = useState('');
  const [compactPane, setCompactPane] = useState<CompactPane>(selectedOrigin ? 'conversation' : 'list');
  const selectedSession = sessions.find((session) => sameOrigin(session, selectedOrigin));
  const selectedMachine = machines.find((machine) => machine.id === selectedSession?.machineId);
  const selectedConversation = conversations.find((conversation) => (
    conversation.machineId === selectedSession?.machineId
    && conversation.threadId === selectedSession?.threadId
  ));

  useEffect(() => {
    if (!selectedSession && compactPane !== 'list') setCompactPane('list');
  }, [compactPane, selectedSession]);

  useEffect(() => {
    if (selectedSession) setCompactPane('conversation');
  }, [selectedSession?.machineId, selectedSession?.threadId]);

  const listPane = useMemo(() => (
    <CodexSessionList
      machines={machines}
      now={now}
      onSelect={(session) => {
        onSelectThread?.({ machineId: session.machineId, threadId: session.threadId });
        setCompactPane('conversation');
      }}
      query={query}
      selectedOrigin={selectedOrigin}
      sessions={sessions}
      setQuery={setQuery}
    />
  ), [machines, now, onSelectThread, query, selectedOrigin, sessions]);

  const conversationPane = (
    <CodexConversationPane
      conversation={selectedConversation}
      machine={selectedMachine}
      onBack={() => setCompactPane('list')}
      onContinue={onContinueThread}
      onOpenDetails={() => setCompactPane('details')}
      session={selectedSession}
    />
  );

  const detailsPane = (
    <CodexSessionDetails
      activeTurnId={activeTurnId}
      conversation={selectedConversation}
      machine={selectedMachine}
      now={now}
      onBack={() => setCompactPane('conversation')}
      onOpenProjectChatThread={onOpenProjectChatThread}
      onInterruptThread={onInterruptThread}
      onResolveApproval={onResolveApproval}
      onResolveUserInput={onResolveUserInput}
      session={selectedSession}
    />
  );

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-neutral-950 text-neutral-100">
      {errorMessage ? (
        <div className="absolute bottom-20 left-1/2 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-red-500/20 bg-neutral-950/95 px-3 py-2 text-[10px] leading-4 text-red-200 shadow-xl min-[1120px]:bottom-auto min-[1120px]:top-3 min-[1120px]:rounded-full">
          <CircleAlert className="size-3.5 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      ) : null}
      <div className="hidden h-full min-h-0 min-[1120px]:grid min-[1120px]:grid-cols-[320px_minmax(0,1fr)_320px]">
        <div className="min-h-0 border-r border-neutral-800/80">{listPane}</div>
        <div className="min-h-0">{conversationPane}</div>
        <div className="min-h-0">{detailsPane}</div>
      </div>

      <div className="h-full min-h-0 min-[1120px]:hidden">
        {compactPane === 'list' ? listPane : null}
        {compactPane === 'conversation' ? conversationPane : null}
        {compactPane === 'details' ? detailsPane : null}
      </div>
    </div>
  );
}
