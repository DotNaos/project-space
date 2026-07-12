import { describe, expect, test } from 'bun:test';
import {
  generalProjectChatChannel,
  projectChatChannelGroups
} from '../src/features/project-chat/project-chat-channel-model';
import type { ProjectChatChannelRecord } from '../src/shared/project-chat-api';

const channels: ProjectChatChannelRecord[] = [
  {
    channelId: 'general',
    description: 'Lobby',
    displayName: 'General',
    kind: 'general'
  },
  {
    channelId: 'channel-a',
    description: 'Project room',
    displayName: 'Same Name',
    groupLabel: '@DotNaos',
    kind: 'project',
    projectId: 'project-a'
  },
  {
    channelId: 'channel-b',
    description: 'Project room',
    displayName: 'Same Name',
    groupLabel: 'Local',
    kind: 'project',
    projectId: 'project-b'
  },
  {
    channelId: 'channel-c',
    description: 'Project room',
    displayName: 'Moodle Services',
    groupLabel: '@DotNaos',
    kind: 'project',
    projectId: 'project-c'
  }
];

describe('Variant B Project Chat channel list model', () => {
  test('keeps General pinned outside project-only search results', () => {
    expect(generalProjectChatChannel(channels)?.channelId).toBe('general');
    expect(projectChatChannelGroups(channels, 'moodle')).toEqual([
      { label: '@DotNaos', channels: [channels[3]] }
    ]);
    expect(projectChatChannelGroups(channels, 'message body text')).toEqual([]);
  });

  test('keeps duplicate display names isolated and groups recent rooms first', () => {
    const groups = projectChatChannelGroups(channels, '', ['project-b']);
    expect(groups[0]).toEqual({ label: 'Recently opened', channels: [channels[2]] });
    expect(groups.flatMap((group) => group.channels).map((channel) => channel.channelId))
      .toEqual(['channel-b', 'channel-c', 'channel-a']);
  });

  test('a rename changes only the label while project and channel identity remain stable', () => {
    const renamed = { ...channels[1]!, displayName: 'Renamed project' };
    expect(renamed).toMatchObject({
      channelId: 'channel-a',
      displayName: 'Renamed project',
      projectId: 'project-a'
    });
  });
});
