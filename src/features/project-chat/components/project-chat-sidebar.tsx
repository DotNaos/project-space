import { Hash, MessageSquareText } from 'lucide-react';
import { Text } from '@/app/dotnaos-ui';
import type { ProjectChatMemberRecord } from '@/shared/project-chat-api';
import { effectiveProjectChatPresence } from '../project-chat-model';
import { ParticipantVisual, PresenceDot } from './participant-visual';

export function ProjectChatSidebar({
  messageCount,
  now,
  viewer
}: {
  messageCount: number;
  now: Date;
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

      <div className="min-h-0 flex-1 px-2 py-5">
        <Text className="px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
          Channels
        </Text>
        <button
          aria-current="page"
          className="mt-2 flex w-full items-center gap-2 rounded-lg bg-neutral-800/70 px-2.5 py-2 text-left text-xs text-neutral-100"
          type="button"
        >
          <Hash className="size-3.5 text-neutral-400" strokeWidth={1.8} />
          <span>general</span>
          <span className="ml-auto font-mono text-[10px] text-neutral-400">{messageCount}</span>
        </button>
        <div className="mt-1 flex items-center gap-2 px-2.5 py-2 text-[11px] text-neutral-400">
          <Hash className="size-3.5" />
          <span>task channels</span>
          <span className="ml-auto border border-neutral-800 px-1.5 py-0.5 text-[8px] uppercase tracking-wider">
            Soon
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5 border-t border-neutral-800/80 p-3">
        <ParticipantVisual role={viewer?.role ?? 'human'} size={30} />
        <div className="min-w-0 flex-1">
          <Text className="block truncate text-xs font-medium text-neutral-200">
            {viewer?.displayName ?? 'Olli'}
          </Text>
          <Text className="block text-[10px] capitalize text-neutral-400">
            {viewer?.role ?? 'Human'}
          </Text>
        </div>
        <PresenceDot state={viewerState} />
      </div>
    </aside>
  );
}
