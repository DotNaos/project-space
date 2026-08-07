import { useMemo, useState, type Key, type ReactNode } from 'react';
import { AtSign, Bot, CircleAlert, Clock3, Hash, MessageSquareText, Radio, Search } from 'lucide-react';
import { Button, Tab, TabList, Tabs, Text } from '@/app/dotnaos-ui';
import type {
  ProjectChatChannelRecord,
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
import {
  generalProjectChatChannel,
  projectChatChannelGroups
} from '../project-chat-channel-model';
import { ParticipantVisual, PresenceDot } from './participant-visual';
import type { CodexSessionTarget } from '../../codex-sessions/codex-session-route';

export type ProjectChatInspectorTab = 'mentions' | 'rooms' | 'threads';

function SectionLabel({ children, className = 'px-4' }: { children: string; className?: string }) {
  return (
    <Text className={`block pb-1 pt-5 text-[11px] font-medium text-neutral-600 ${className}`}>
      {children}
    </Text>
  );
}

function EmptyNote({ children }: { children: string }) {
  return <Text className="block px-4 py-4 text-sm text-neutral-600">{children}</Text>;
}

function RoomButton({
  channel,
  onSelect,
  selected
}: {
  channel: ProjectChatChannelRecord;
  onSelect(channel: ProjectChatChannelRecord): void;
  selected: boolean;
}) {
  return (
    <button
      aria-current={selected ? 'page' : undefined}
      aria-label={`Open the ${channel.displayName} room`}
      className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition ${
        selected
          ? 'bg-neutral-800/80 text-neutral-100'
          : 'text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200'
      }`}
      onClick={() => onSelect(channel)}
      type="button"
    >
      <Hash className="size-3.5 shrink-0 text-neutral-600" strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{channel.displayName}</span>
    </button>
  );
}

function RoomRows({
  channels,
  onSelectChannel,
  recentProjectIds,
  selectedChannelId
}: {
  channels: ProjectChatChannelRecord[];
  onSelectChannel?(channel: ProjectChatChannelRecord): void;
  recentProjectIds: string[];
  selectedChannelId: string;
}) {
  const [query, setQuery] = useState('');
  const general = generalProjectChatChannel(channels);
  const groups = projectChatChannelGroups(channels, query, recentProjectIds);
  const hasProjectRooms = channels.some((channel) => channel.kind === 'project');

  if (!onSelectChannel) {
    return <EmptyNote>This room is pinned to the current project.</EmptyNote>;
  }

  return (
    <div className="px-2 pb-4 pt-2">
      <label className="flex h-9 items-center gap-2 rounded-full bg-neutral-900/80 px-3">
        <Search className="size-3.5 shrink-0 text-neutral-600" />
        <span className="sr-only">Find rooms</span>
        <input
          aria-label="Find rooms"
          className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search rooms"
          type="search"
          value={query}
        />
      </label>

      {general ? (
        <div className="mt-3">
          <SectionLabel className="px-2">Lobby</SectionLabel>
          <RoomButton
            channel={general}
            onSelect={onSelectChannel}
            selected={selectedChannelId === general.channelId}
          />
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={group.label}>
          <SectionLabel className="px-2">{group.label}</SectionLabel>
          <div className="space-y-0.5">
            {group.channels.map((channel) => (
              <RoomButton
                channel={channel}
                key={channel.channelId}
                onSelect={onSelectChannel}
                selected={selectedChannelId === channel.channelId}
              />
            ))}
          </div>
        </div>
      ))}

      {groups.length === 0 ? (
        <Text className="block px-2 py-4 text-sm leading-6 text-neutral-600">
          {hasProjectRooms
            ? `No rooms match “${query.trim()}”.`
            : 'No project rooms are available.'}
        </Text>
      ) : null}
    </div>
  );
}

function AgentRows({
  members,
  now,
  onOpenThread,
  onSelectMember,
  selectedMemberId
}: {
  members: ProjectChatMemberRecord[];
  now: Date;
  onOpenThread?(target: CodexSessionTarget): void;
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
        const origin = member.origin;
        return (
          <div
            className="flex w-full items-center gap-1 pr-2 transition hover:bg-neutral-900/50 aria-pressed:bg-neutral-900/70"
            key={member.memberId}
          >
            <button
              aria-pressed={selected}
              className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 pl-4 text-left"
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
                  {origin?.taskTitle ?? `@${member.handle}`}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-600">
                {projectChatPresenceLabel(presence)}
                <PresenceDot state={presence} />
              </span>
            </button>
            {onOpenThread && origin ? (
              <Button
                aria-label={`Open the Codex thread of ${member.displayName}`}
                className="size-8 min-h-0 shrink-0"
                isIconOnly
                onPress={() => onOpenThread({
                  machineId: origin.machineId,
                  threadId: origin.threadId
                })}
                size="sm"
                variant="ghost"
              >
                <Radio className="size-3.5" />
              </Button>
            ) : null}
          </div>
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
  canSwitchRooms = false,
  channels,
  threadDirectory,
  members,
  mentionError,
  mentionMessages,
  messages,
  now,
  onOpenThread,
  onSelectChannel,
  onSelectMember,
  onSelectMessage,
  onSelectTab,
  onSelectThread,
  onRetryMention,
  recentProjectIds = [],
  selectedChannelId,
  selectedMemberId,
  selectedThreadKey,
  unreadMentionCount
}: {
  activeTab: ProjectChatInspectorTab;
  canSwitchRooms?: boolean;
  channels: ProjectChatChannelRecord[];
  /** Codex thread directory across every machine, supplied by the desktop shell. */
  threadDirectory?: ReactNode;
  members: ProjectChatMemberRecord[];
  mentionError?: string;
  mentionMessages: ProjectChatMessageRecord[];
  messages: ProjectChatMessageRecord[];
  now: Date;
  onOpenThread?(target: CodexSessionTarget): void;
  onSelectChannel?(channel: ProjectChatChannelRecord): void;
  onSelectMember(memberId: string): void;
  onSelectMessage(message: ProjectChatMessageRecord): void;
  onSelectTab(tab: ProjectChatInspectorTab): void;
  onSelectThread(thread: ProjectChatThreadSummary): void;
  onRetryMention?(): void;
  recentProjectIds?: string[];
  selectedChannelId: string;
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
        <TabList className="flex w-full items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {canSwitchRooms ? <Tab className="shrink-0 !px-2 text-xs" id="rooms">Rooms</Tab> : null}
          <Tab className="shrink-0 gap-1 !px-2 text-xs" id="mentions">
            Mentions
            {unreadMentionCount > 0 ? (
              <span className="grid min-w-4 place-items-center rounded-full bg-sky-400/15 px-1 text-[10px] font-medium text-sky-300">
                {unreadMentionCount}
              </span>
            ) : null}
          </Tab>
          <Tab className="shrink-0 !px-2 text-xs" id="threads">Threads</Tab>
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
        {activeTab === 'rooms' && canSwitchRooms ? (
          <RoomRows
            channels={channels}
            onSelectChannel={onSelectChannel}
            recentProjectIds={recentProjectIds}
            selectedChannelId={selectedChannelId}
          />
        ) : null}
        {activeTab === 'mentions' ? (
          <>
            <MentionRows messages={mentionMessages} onSelectMessage={onSelectMessage} />
            {agentMembers.length > 0 ? (
              <>
                <SectionLabel>Active agents</SectionLabel>
                <AgentRows members={members} now={now} onOpenThread={onOpenThread} onSelectMember={onSelectMember} selectedMemberId={selectedMemberId} />
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
        {activeTab === 'threads' ? (
          <>
            {threadDirectory}
            {agentMembers.length > 0 ? (
              <>
                <SectionLabel>Room agents</SectionLabel>
                <AgentRows members={members} now={now} onOpenThread={onOpenThread} onSelectMember={onSelectMember} selectedMemberId={selectedMemberId} />
              </>
            ) : null}
            {threads.length > 0 ? (
              <>
                <SectionLabel>Origin threads in this room</SectionLabel>
                <ThreadRows onSelectThread={onSelectThread} selectedThreadKey={selectedThreadKey} threads={threads} />
              </>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 border-t border-neutral-800/70 px-4 py-3 text-[11px] text-neutral-600">
        {activeTab === 'rooms' ? <Hash className="size-3.5" />
          : activeTab === 'threads' ? <Bot className="size-3.5" />
          : <Clock3 className="size-3.5" />}
        {activeTab === 'rooms'
          ? `${channels.length} ${channels.length === 1 ? 'room' : 'rooms'}`
          : activeTab === 'mentions'
            ? 'Unread mentions only'
            : 'Open a thread to connect to its agent'}
      </div>
    </aside>
  );
}
