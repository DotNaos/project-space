import { Hash, MessageSquareText, Search } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import type {
  ProjectChatChannelRecord,
  ProjectChatMemberRecord
} from '@/shared/project-chat-api';
import { effectiveProjectChatPresence } from '../project-chat-model';
import {
  generalProjectChatChannel,
  projectChatChannelGroups
} from '../project-chat-channel-model';
import { ParticipantVisual, PresenceDot } from './participant-visual';
import { useState } from 'react';

export function ProjectChatChannelList({
  channels,
  onSelectChannel,
  recentProjectIds = [],
  selectedChannelId
}: {
  channels: ProjectChatChannelRecord[];
  onSelectChannel(channel: ProjectChatChannelRecord): void;
  recentProjectIds?: string[];
  selectedChannelId: string;
}) {
  const [query, setQuery] = useState('');
  const general = generalProjectChatChannel(channels);
  const groups = projectChatChannelGroups(channels, query, recentProjectIds);
  const hasProjects = channels.some((channel) => channel.kind === 'project');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-3 pt-5">
        <Text className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
          Lobby
        </Text>
        {general ? (
          <ChannelButton
            channel={general}
            onSelect={onSelectChannel}
            selected={selectedChannelId === general.channelId}
          />
        ) : null}

        <div className="mt-5 flex items-center justify-between px-1">
          <Text className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
            Project rooms
          </Text>
        </div>
        <label className="mt-2 flex h-8 items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/70 px-2.5 focus-within:border-neutral-600">
          <Search className="size-3.5 shrink-0 text-neutral-500" />
          <span className="sr-only">Find project rooms</span>
          <input
            aria-label="Find project rooms"
            className="min-w-0 flex-1 bg-transparent text-xs text-neutral-100 outline-none placeholder:text-neutral-500"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search rooms"
            type="search"
            value={query}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-3">
        {groups.map((group) => (
          <section className="mb-4" key={group.label}>
            <Text className="block truncate px-1 pb-1.5 text-[10px] text-neutral-500">
              {group.label}
            </Text>
            <div className="space-y-0.5">
              {group.channels.map((channel) => (
                <ChannelButton
                  channel={channel}
                  key={channel.channelId}
                  onSelect={onSelectChannel}
                  selected={selectedChannelId === channel.channelId}
                />
              ))}
            </div>
          </section>
        ))}
        {groups.length === 0 ? (
          <Text className="block px-1 py-3 text-xs leading-5 text-neutral-500">
            {hasProjects
              ? `No project rooms match “${query.trim()}”.`
              : 'No project rooms are available.'}
          </Text>
        ) : null}
      </div>
    </div>
  );
}

function ChannelButton({
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
      className={
        `mt-1 flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
          selected
            ? 'bg-neutral-800/80 text-neutral-100'
            : 'text-neutral-400 hover:bg-neutral-900/80 hover:text-neutral-200'
        }`
      }
      onClick={() => onSelect(channel)}
      type="button"
    >
      <Hash className="size-3.5 shrink-0 text-neutral-500" strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{channel.displayName}</span>
    </button>
  );
}

export function ProjectChatSidebar({
  channels,
  now,
  onEditProfile,
  onSelectChannel,
  recentProjectIds,
  selectedChannelId,
  viewer
}: {
  channels: ProjectChatChannelRecord[];
  now: Date;
  onEditProfile?(): void;
  onSelectChannel(channel: ProjectChatChannelRecord): void;
  recentProjectIds?: string[];
  selectedChannelId: string;
  viewer?: ProjectChatMemberRecord;
}) {
  const viewerState = viewer ? effectiveProjectChatPresence(viewer, now) : 'offline';

  return (
    <aside className="flex min-h-0 flex-col border-r border-neutral-800/80 bg-neutral-950/65 max-[719px]:hidden">
      <div className="flex h-[68px] shrink-0 items-center gap-3 border-b border-neutral-800/80 px-4">
        <span className="grid size-8 place-items-center rounded-lg bg-neutral-100 text-neutral-950">
          <MessageSquareText className="size-4" strokeWidth={1.8} />
        </span>
        <div className="min-w-0">
          <Text className="block truncate text-sm font-semibold text-neutral-100">Project Chat</Text>
          <Text className="block text-[10px] text-neutral-400">Shared workspace</Text>
        </div>
      </div>

      <ProjectChatChannelList
        channels={channels}
        onSelectChannel={onSelectChannel}
        recentProjectIds={recentProjectIds}
        selectedChannelId={selectedChannelId}
      />

      <button
        aria-label="Edit your Project Chat profile"
        className="flex min-h-14 shrink-0 items-center gap-2.5 border-t border-neutral-800/80 p-3 text-left hover:bg-neutral-900/70 disabled:cursor-default disabled:hover:bg-transparent"
        disabled={!onEditProfile || viewer?.role !== 'human'}
        onClick={onEditProfile}
        type="button"
      >
        <ParticipantVisual
          avatarUrl={viewer?.avatarUrl}
          displayName={viewer?.displayName}
          role={viewer?.role ?? 'human'}
          size={30}
        />
        <div className="min-w-0 flex-1">
          <Text className="block truncate text-xs font-medium text-neutral-200">
            {viewer?.displayName ?? 'Olli'}
          </Text>
          <Text className="block text-[10px] capitalize text-neutral-400">
            {viewer?.role ?? 'Human'}
          </Text>
        </div>
        <PresenceDot state={viewerState} />
      </button>
    </aside>
  );
}
