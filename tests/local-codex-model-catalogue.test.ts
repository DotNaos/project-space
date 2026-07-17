import { describe, expect, test } from 'bun:test';

import { readCodexModelPage } from '../server/local-codex-app-server-client';

describe('local Codex model catalogue', () => {
  test('preserves model reasoning and service-tier options from the real App Server catalogue', () => {
    expect(readCodexModelPage({
      data: [{
        defaultReasoningEffort: 'high',
        defaultServiceTier: 'fast',
        description: 'Latest frontier agentic coding model.',
        displayName: 'GPT-5.6 Sol',
        hidden: false,
        id: 'gpt-5.6-sol',
        isDefault: true,
        model: 'gpt-5.6-sol',
        serviceTiers: [
          { description: 'Standard response speed.', id: 'standard', name: 'Standard' },
          { description: 'Faster response speed.', id: 'fast', name: 'Fast' }
        ],
        supportedReasoningEfforts: [
          { description: 'Fast answers.', reasoningEffort: 'low' },
          { description: 'Deeper reasoning.', reasoningEffort: 'high' },
          { description: 'Maximum reasoning.', reasoningEffort: 'xhigh' }
        ]
      }],
      nextCursor: null
    })).toEqual({
      models: [{
        defaultReasoningEffort: 'high',
        defaultServiceTier: 'fast',
        description: 'Latest frontier agentic coding model.',
        displayName: 'GPT-5.6 Sol',
        id: 'gpt-5.6-sol',
        isDefault: true,
        model: 'gpt-5.6-sol',
        serviceTiers: [
          { description: 'Standard response speed.', id: 'standard', name: 'Standard' },
          { description: 'Faster response speed.', id: 'fast', name: 'Fast' }
        ],
        supportedReasoningEfforts: [
          { description: 'Fast answers.', reasoningEffort: 'low' },
          { description: 'Deeper reasoning.', reasoningEffort: 'high' },
          { description: 'Maximum reasoning.', reasoningEffort: 'xhigh' }
        ]
      }],
      nextCursor: undefined
    });
  });
});
