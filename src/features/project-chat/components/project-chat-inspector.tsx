import { useMemo, type Key } from 'react';
import { AtSign, Bot, CircleAlert, Clock3, MessageSquareText } from 'lucide-react';
import { Tab, TabList, Tabs, Text } from '@/app/dotnaos-ui';
import type {
  ProjectChatMemberRecord,
  ProjectChatMessageRecord
} from '@/shared/project-chat-api';
import {
  effectiveProjectChatPresence,
  formatProjectChatActivity,
  formatProjectChatTime,
  projectChatPresenceLabel,
  projectChatAgentNameIdentity,
  projectChatThreads,
  shortProjectChatId,
  type ProjectChatThreadSummary
} from '../project-chat-model';
import { ParticipantVisual, PresenceDot } from './participant-visual';

export type ProjectChatInspectorTab = 'agents' | 'mentions' | 'threads';

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="block px-3 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
      {children}
    </Text>
  );
}

function AgentRows({
  members,
  now,
  onSelectMember,
  selectedMemberId
}: {
  members: ProjectChatMemberRecord[];
  now: Date;
  onSelectMember(memberId: string): void;
  selectedMemberId?: string;
}) {
  const agents = [...members]
    .filter((member) => member.role === 'agent')
    .sort((left, right) => {
      const rank = { idle: 1, offline: 2, working: 0 };
      return rank[effectiveProjectChatPresence(left, now)] - rank[effectiveProjectChatPresence(right, now)] || left.displayName.localeCompare(right.displayName);
    });

  if (agents.length === 0) {
    return <Text className="block px-3 py-4 text-xs text-neutral-400">No agents have joined yet.</Text>;
  }

  return (
    <div className="divide-y divide-neutral-900">
      {agents.map((member) => {
        const agentName = projectChatAgentNameIdentity(member);
        const presence = effectiveProjectChatPresence(member, now);
        const selected = selectedMemberId === member.memberId;
        return (
          <button
            aria-pressed={selected}
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-neutral-900/70 aria-pressed:bg-neutral-900"
            key={member.memberId}
            onClick={() => onSelectMember(member.memberId)}
            type="button"
          >
            <ParticipantVisual
              active={presence === 'working'}
              agentCategory={agentName?.category}
              agentName={agentName?.name}
              role="agent"
              selected={selected}
              size={24}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-medium text-neutral-300">{member.displayName}</span>
              <span className="block truncate text-[10px] text-neutral-400">{member.origin?.taskTitle ?? `@${member.handle}`}</span>
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-neutral-400">
              {projectChatPresenceLabel(presence)}
              <PresenceDot state={presence} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ThreadRows({
  onSelectThread,
  selectedThreadId,
  threads
}: {
  onSelectThread(thread: ProjectChatThreadSummary): void;
  selectedThreadId?: string;
  threads: ProjectChatThreadSummary[];
}) {
  if (threads.length === 0) {
    return <Text className="block px-3 py-4 text-xs text-neutral-400">No origin threads in this channel.</Text>;
  }

  return (
    <div className="divide-y divide-neutral-900">
      {threads.map((thread) => (
        <button
          aria-pressed={selectedThreadId === thread.threadId}
          className="grid w-full grid-cols-[62px_minmax(0,1fr)] gap-2 px-3 py-2.5 text-left transition hover:bg-neutral-900/70 aria-pressed:bg-neutral-900"
          key={thread.threadId}
          onClick={() => onSelectThread(thread)}
          type="button"
        >
          <span className="whitespace-nowrap font-mono text-[10px] text-neutral-400">{shortProjectChatId(thread.threadId)}</span>
          <span className="min-w-0">
            <span className="block truncate text-[10px] text-neutral-400">{thread.taskTitle}</span>
            <span className="mt-0.5 block truncate text-[10px] text-neutral-400">{thread.memberName}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function MentionRows({
  messages,
  onSelectMessage
}: {
  messages: ProjectChatMessageRecord[];
  onSelectMessage(message: ProjectChatMessageRecord): void;
}) {
  if (messages.length === 0) {
    return <Text className="block px-3 py-4 text-xs text-neutral-400">No unread mentions.</Text>;
  }

  return (
    <div className="divide-y divide-neutral-900">
      {messages.map((message) => (
        <button
          className="w-full px-3 py-3 text-left transition hover:bg-neutral-900/70"
          key={message.id}
          onClick={() => onSelectMessage(message)}
          type="button"
        >
          <span className="flex items-center gap-2 text-[10px] font-medium text-neutral-300">
            <AtSign className="size-3 text-neutral-400" />
            You were mentioned in #general
            <time className="ml-auto text-[10px] font-normal text-neutral-400">{formatProjectChatTime(message.createdAt)}</time>
          </span>
          <span className="mt-1.5 line-clamp-2 block text-[11px] leading-4 text-neutral-400">{message.body}</span>
        </button>
      ))}
    </div>
  );
}

export function ProjectChatInspector({
  activeTab,
  members,
  mentionError,
  mentionMessages,
  messages,
  now,
  onSelectMember,
  onSelectMessage,
  onSelectTab,
  onSelectThread,
  onRetryMention,
  selectedMemberId,
  selectedThreadId,
  unreadMentionCount
}: {
  activeTab: ProjectChatInspectorTab;
  members: ProjectChatMemberRecord[];
  mentionError?: string;
  mentionMessages: ProjectChatMessageRecord[];
  messages: ProjectChatMessageRecord[];
  now: Date;
  onSelectMember(memberId: string): void;
  onSelectMessage(message: ProjectChatMessageRecord): void;
  onSelectTab(tab: ProjectChatInspectorTab): void;
  onSelectThread(thread: ProjectChatThreadSummary): void;
  onRetryMention?(): void;
  selectedMemberId?: string;
  selectedThreadId?: string;
  unreadMentionCount: number;
}) {
  const threads = useMemo(() => projectChatThreads(messages, members), [members, messages]);

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-neutral-800/80 bg-neutral-950/75">
      <Tabs
        className="flex h-[68px] shrink-0 items-end border-b border-neutral-800/80 px-2"
        onSelectionChange={(key: Key) => onSelectTab(String(key) as ProjectChatInspectorTab)}
        selectedKey={activeTab}
      >
        <TabList className="flex w-full items-center">
          <Tab className="min-w-0 flex-1 px-1 text-[10px]" id="mentions">
            Mentions
            {unreadMentionCount > 0 ? (
              <span className="grid min-w-4 place-items-center rounded-full bg-neutral-100 px-1 text-[8px] font-bold text-neutral-950">
                {unreadMentionCount}
              </span>
            ) : null}
          </Tab>
          <Tab className="min-w-0 flex-1 px-1 text-[10px]" id="agents">Agents</Tab>
          <Tab className="min-w-0 flex-1 px-1 text-[10px]" id="threads">Threads</Tab>
        </TabList>
      </Tabs>

      {mentionError ? (
        <div aria-live="polite" className="flex items-start gap-2 border-b border-red-400/20 px-3 py-2.5 text-[10px] leading-4 text-red-200" role="alert">
          <CircleAlert className="mt-0.5 size-3 shrink-0" />
          <span>{mentionError}</span>
          {onRetryMention ? (
            <button className="ml-auto shrink-0 font-medium underline" onClick={onRetryMention} type="button">Retry</button>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === 'mentions' ? (
          <>
            <MentionRows messages={mentionMessages} onSelectMessage={onSelectMessage} />
            <SectionLabel>Active agents</SectionLabel>
            <AgentRows members={members} now={now} onSelectMember={onSelectMember} selectedMemberId={selectedMemberId} />
            <SectionLabel>Recent threads</SectionLabel>
            <ThreadRows onSelectThread={onSelectThread} selectedThreadId={selectedThreadId} threads={threads.slice(0, 4)} />
          </>
        ) : null}
        {activeTab === 'agents' ? (
          <>
            <SectionLabel>Room members</SectionLabel>
            <AgentRows members={members} now={now} onSelectMember={onSelectMember} selectedMemberId={selectedMemberId} />
          </>
        ) : null}
        {activeTab === 'threads' ? (
          <>
            <SectionLabel>Origin threads</SectionLabel>
            <ThreadRows onSelectThread={onSelectThread} selectedThreadId={selectedThreadId} threads={threads} />
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-2 border-t border-neutral-900 px-3 py-2.5 text-[10px] text-neutral-400">
        {activeTab === 'agents' ? <Bot className="size-3" /> : activeTab === 'threads' ? <MessageSquareText className="size-3" /> : <Clock3 className="size-3" />}
        {activeTab === 'mentions' ? 'Unread mention evidence only' : activeTab === 'agents' ? 'Presence expires when stale' : `${threads.length} recent origins`}
      </div>
    </aside>
  );
}
