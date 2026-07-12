import type { ProjectChatChannelRecord } from '@/shared/project-chat-api';

export interface ProjectChatChannelGroup {
  label: string;
  channels: ProjectChatChannelRecord[];
}

export function projectChatChannelGroups(
  channels: ProjectChatChannelRecord[],
  query: string,
  recentProjectIds: string[] = []
) {
  const normalizedQuery = normalize(query);
  const projects = channels
    .filter((channel) => channel.kind === 'project')
    .filter((channel) => !normalizedQuery || normalize(channel.displayName).includes(normalizedQuery));
  const recentOrder = new Map(recentProjectIds.map((id, index) => [id, index]));
  const recent = projects
    .filter((channel) => {
      const recentId = channel.navigationProjectId ?? channel.projectId;
      return Boolean(recentId && recentOrder.has(recentId));
    })
    .sort((left, right) => (
      recentOrder.get(left.navigationProjectId ?? left.projectId!)! -
      recentOrder.get(right.navigationProjectId ?? right.projectId!)!
    ));
  const recentIds = new Set(recent.map((channel) => channel.channelId));
  const byGroup = new Map<string, ProjectChatChannelRecord[]>();
  for (const channel of projects.filter((candidate) => !recentIds.has(candidate.channelId))) {
    const label = channel.groupLabel?.trim() || 'Projects';
    byGroup.set(label, [...(byGroup.get(label) ?? []), channel]);
  }
  const groups: ProjectChatChannelGroup[] = [];
  if (recent.length > 0) groups.push({ channels: recent, label: 'Recently opened' });
  for (const [label, groupChannels] of [...byGroup.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    groups.push({
      channels: groupChannels.sort((left, right) => left.displayName.localeCompare(right.displayName)),
      label
    });
  }
  return groups;
}

export function generalProjectChatChannel(channels: ProjectChatChannelRecord[]) {
  return channels.find((channel) => channel.kind === 'general');
}

function normalize(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}
