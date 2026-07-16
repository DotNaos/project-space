import { describe, expect, test } from 'bun:test';
import { shouldShowProjectSpaceSessionGate } from '../src/features/project-desktop/components/project-desktop-session-gate';

describe('Project Space session gate', () => {
  test('keeps an already verified workspace mounted during a background session check', () => {
    expect(shouldShowProjectSpaceSessionGate({
      currentUserId: 'user-one',
      isCheckingSession: true,
      isLoaded: true,
      verifiedUserId: 'user-one'
    })).toBe(false);
  });

  test('gates the workspace before the first check and when the signed-in user changes', () => {
    expect(shouldShowProjectSpaceSessionGate({
      currentUserId: 'user-one',
      isCheckingSession: true,
      isLoaded: true
    })).toBe(true);
    expect(shouldShowProjectSpaceSessionGate({
      currentUserId: 'user-two',
      isCheckingSession: true,
      isLoaded: true,
      verifiedUserId: 'user-one'
    })).toBe(true);
    expect(shouldShowProjectSpaceSessionGate({
      isCheckingSession: true,
      isLoaded: true
    })).toBe(true);
  });

  test('always gates while Clerk itself is still loading', () => {
    expect(shouldShowProjectSpaceSessionGate({
      currentUserId: 'user-one',
      isCheckingSession: false,
      isLoaded: false,
      verifiedUserId: 'user-one'
    })).toBe(true);
  });
});
