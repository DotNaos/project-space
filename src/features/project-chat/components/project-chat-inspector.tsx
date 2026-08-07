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
    <Text className="block px-4 pb-1 pt-5 text-[11px] font-medium text-neutral-600">
      {children}
    </Text>
  );
}

function EmptyNote({ children }: { children: string }) {
  return <Text className="block px-4 py-4 text-sm text-neutral-600">{children}</Text>;
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
    return <EmptyNote>No agents have joined yet.</EmptyNote>;
  }

  return (
    <div className="divide-y divide-neutral-800/50">
      {agents.map((member) => {
        const agentName = projectChatAgentNameIdentity(member);
        const presence = effectiveProjectChatPresence(member, now);
        const selected = selectedMemberId === member.memberId;
        return (
          <button
            aria-pressed={selected}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left transition hover:bg-neutral-900/50 aria-pressed:bg-neutral-900/70"
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
              <span className="block truncate text-sm text-neutral-300">{member.displayName}</span>
              <span className="block truncate text-[11px] text-neutral-600">
                {member.origin?.taskTitle ?? `@${member.handle}`}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-600">
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
  selectedThreadKey,
  threads
}: {
  onSelectThread(thread: ProjectChatThreadSummary): void;
  selectedThreadKey?: string;
  threads: ProjectChatThreadSummary[];
}) {
  if (threads.length === 0) {
    return <EmptyNote>No origin threads in this room.</EmptyNote>;
  }

  return (
    <div className="divide-y divide-neutral-800/50">
      {threads.map((thread) => (
        <button
          aria-pressed={selectedThreadKey === thread.id}
          className="grid w-full gap-1 px-4 py-2.5 text-left transition hover:bg-neutral-900/50 aria-pressed:bg-neutral-900/70"
          key={thread.id}
          onClick={() => onSelectThread(thread)}
          type="button"
        >
          <span className="truncate text-sm text-neutral-300">{thread.taskTitle}</span>
          <span className="flex min-w-0 items-center gap-2 text-[11px] text-neutral-600">
            <span className="shrink-0 font-mono">{shortProjectChatId(thread.threadId)}</span>
            <span className="truncate">{thread.memberName}</span>
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
    return <EmptyNote>No unread mentions.</EmptyNote>;
  }

  return (
    <div className="divide-y divide-neutral-800/50">
      {messages.map((message) => (
        <button
          className="w-full px-4 py-3 text-left transition hover:bg-neutral-900/50"
          key={message.id}
          onClick={() => onSelectMessage(message)}
          type="button"
        >
          <span className="flex items-center gap-1.5 text-[11px] text-sky-300/90">
            <AtSign className="size-3 shrink-0" />
            Mentioned you
            <time className="ml-auto shrink-0 text-neutral-600">
              {formatProjectChatTime(message.createdAt)}
            </time>
          </span>
          <span className="mt-1 line-clamp-2 block text-sm leading-5 text-neutral-400">
            {message.body}
          </span>
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
  selectedThreadKey,
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
  selectedThreadKey?: string;
  unreadMentionCount: number;
}) {
  const threads = useMemo(() => projectChatThreads(messages, members), [members, messages]);
  const agentMembers = useMemo(
    () => members.filter((member) => member.role === 'agent'),
    [members]
  );

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-neutral-800/70">
      <Tabs
        className="flex shrink-0 items-center border-b border-neutral-800/70 px-2 py-3"
        onSelectionChange={(key: Key) => onSelectTab(String(key) as ProjectChatInspectorTab)}
        selectedKey={activeTab}
      >
        <TabList className="flex w-full items-center gap-1">
          <Tab className="min-w-0 flex-1 gap-1.5 rounded-full px-2 text-xs" id="mentions">
            Mentions
            {unreadMentionCount > 0 ? (
              <span className="grid min-w-4 place-items-center rounded-full bg-sky-400/15 px-1 text-[10px] font-medium text-sky-300">
                {unreadMentionCount}
              </span>
            ) : null}
          </Tab>
          <Tab className="min-w-0 flex-1 rounded-full px-2 text-xs" id="agents">Agents</Tab>
          <Tab className="min-w-0 flex-1 rounded-full px-2 text-xs" id="threads">Threads</Tab>
        </TabList>
      </Tabs>

      {mentionError ? (
        <div
          aria-live="polite"
          className="mx-3 mt-3 flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/[.07] px-3 py-2 text-xs leading-5 text-red-200/90"
          role="alert"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{mentionError}</span>
          {onRetryMention ? (
            <button className="ml-auto shrink-0 underline" onClick={onRetryMention} type="button">Retry</button>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeTab === 'mentions' ? (
          <>
            <MentionRows messages={mentionMessages} onSelectMessage={onSelectMessage} />
            {agentMembers.length > 0 ? (
              <>
                <SectionLabel>Active agents</SectionLabel>
                <AgentRows members={members} now={now} onSelectMember={onSelectMember} selectedMemberId={selectedMemberId} />
              </>
            ) : null}
            {threads.length > 0 ? (
              <>
                <SectionLabel>Recent threads</SectionLabel>
                <ThreadRows onSelectThread={onSelectThread} selectedThreadKey={selectedThreadKey} threads={threads.slice(0, 4)} />
              </>
            ) : null}
          </>
        ) : null}
        {activeTab === 'agents' ? (
          <AgentRows members={members} now={now} onSelectMember={onSelectMember} selectedMemberId={selectedMemberId} />
        ) : null}
        {activeTab === 'threads' ? (
          <ThreadRows onSelectThread={onSelectThread} selectedThreadKey={selectedThreadKey} threads={threads} />
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 border-t border-neutral-800/70 px-4 py-3 text-[11px] text-neutral-600">
        {activeTab === 'agents' ? <Bot className="size-3.5" /> : activeTab === 'threads' ? <MessageSquareText className="size-3.5" /> : <Clock3 className="size-3.5" />}
        {activeTab === 'mentions'
          ? 'Unread mentions only'
          : activeTab === 'agents'
            ? `${agentMembers.length} ${agentMembers.length === 1 ? 'agent' : 'agents'} · presence expires when stale`
            : `${threads.length} ${threads.length === 1 ? 'origin thread' : 'origin threads'}`}
      </div>
    </aside>
  );
}
