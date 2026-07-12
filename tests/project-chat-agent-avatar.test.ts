import { describe, expect, test } from 'bun:test';
import {
  PROJECT_CHAT_GOLDEN_ANGLE,
  projectChatAvatarHash,
  projectChatAvatarHue,
  renderProjectChatAgentAvatar,
  projectChatNameRequiresParent,
  type ProjectChatAgentAvatarCategory
} from '../src/features/project-chat/project-chat-agent-avatar';

function pixelHash(pixels: Uint8ClampedArray) {
  let hash = 2166136261;
  for (const value of pixels) {
    hash ^= value;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

describe('Project Chat deterministic agent avatars', () => {
  test('requires a parent thread for every specialist group but never mythology', () => {
    expect(projectChatNameRequiresParent('mythology')).toBe(false);
    expect(projectChatNameRequiresParent('artist')).toBe(true);
    expect(projectChatNameRequiresParent('science')).toBe(true);
    expect(projectChatNameRequiresParent('scientist')).toBe(true);
    expect(projectChatNameRequiresParent('detective')).toBe(true);
  });
  test('uses the exact stable FNV-1a name hash and golden-angle color mapping', () => {
    expect(projectChatAvatarHash('Athena')).toBe(3582994374);
    expect(projectChatAvatarHash('athena')).toBe(2407209638);
    expect(projectChatAvatarHue('Athena')).toBe((2407209638 % 4096) * PROJECT_CHAT_GOLDEN_ANGLE % 360);
    expect(projectChatAvatarHue('ATHENA')).toBe(projectChatAvatarHue('athena'));
    expect(projectChatAvatarHue('Picasso')).toBeCloseTo(249.06086340383627, 10);
  });

  test('renders the approved category fields deterministically', () => {
    const expected: Record<ProjectChatAgentAvatarCategory, number> = {
      artist: 2257733678,
      detective: 2844244380,
      gradient: 899889406,
      mythology: 486383446,
      science: 1361279115
    };
    for (const [category, hash] of Object.entries(expected)) {
      const first = renderProjectChatAgentAvatar(
        'Athena',
        category as ProjectChatAgentAvatarCategory,
        16
      );
      const second = renderProjectChatAgentAvatar(
        'Athena',
        category as ProjectChatAgentAvatarCategory,
        16
      );
      expect(first).toEqual(second);
      expect(pixelHash(first)).toBe(hash);
    }
  });

  test('keeps every category visually distinct at message-avatar size', () => {
    const categories: ProjectChatAgentAvatarCategory[] = [
      'mythology', 'artist', 'science', 'detective', 'gradient'
    ];
    const hashes = categories.map((category) => (
      pixelHash(renderProjectChatAgentAvatar('Athena', category, 24))
    ));
    expect(new Set(hashes).size).toBe(categories.length);
  });

  test('uses name for color and category plus name for the pattern seed', () => {
    expect(projectChatAvatarHue('Athena')).not.toBe(projectChatAvatarHue('Hermes'));
    expect(pixelHash(renderProjectChatAgentAvatar('Athena', 'artist', 24)))
      .not.toBe(pixelHash(renderProjectChatAgentAvatar('Hermes', 'artist', 24)));
    expect(pixelHash(renderProjectChatAgentAvatar('Athena', 'artist', 24)))
      .not.toBe(pixelHash(renderProjectChatAgentAvatar('Athena', 'science', 24)));
  });
});
