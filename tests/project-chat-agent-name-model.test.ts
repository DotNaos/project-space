import { describe, expect, test } from 'bun:test';

import { projectChatAgentNameIdentity } from '../src/features/project-chat/project-chat-model';

describe('Project Chat registry identity model', () => {
  test('reads agent registry identity without changing human or malformed records', () => {
    expect(projectChatAgentNameIdentity({
      agentName: { category: 'scientist', displayName: 'Athena.Turing', name: 'Turing' }
    })).toEqual({ category: 'science', displayName: 'Athena.Turing', name: 'Turing' });
    expect(projectChatAgentNameIdentity({ agentName: { category: 'artist', name: 'Picasso' } }))
      .toEqual({ category: 'artist', displayName: 'Picasso', name: 'Picasso' });
    expect(projectChatAgentNameIdentity({ displayName: 'Human' })).toBeUndefined();
  });
});
