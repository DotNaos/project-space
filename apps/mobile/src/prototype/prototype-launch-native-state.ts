import type {
  PrototypeLaunchIdentity,
  PrototypeLaunchState,
} from '../../../../src/shared/prototype-launch';
import { parsePrototypeLaunchRouteIdentity } from '../../../../src/shared/prototype-launch';

export type NativePrototypeContext = 'issue' | 'pull-request' | 'prototype';
export type NativePrototypeSurfaceMode = 'deployed' | 'local';

export interface NativePrototypeStateOption {
  description: string;
  label: string;
  state: PrototypeLaunchState;
}

export interface NativePrototypeCapabilities {
  annotations: boolean;
  codexFeedback: boolean;
  hostAccess: boolean;
  readOnly: boolean;
}

export const NATIVE_PROTOTYPE_STATE_OPTIONS: readonly NativePrototypeStateOption[] =
  [
    {
      description: 'No matching prototype has been started for this head.',
      label: 'Not started',
      state: 'not-started',
    },
    {
      description: 'The exact PR head is being prepared on the selected machine.',
      label: 'Starting',
      state: 'starting',
    },
    {
      description: 'The prototype is verified for this repository, PR, and head.',
      label: 'Ready',
      state: 'ready',
    },
    {
      description: 'The available prototype belongs to a different head.',
      label: 'Stale',
      state: 'stale',
    },
    {
      description: 'The prototype could not be reached or verified.',
      label: 'Unavailable',
      state: 'unavailable',
    },
    {
      description: 'The matching development session is currently stopped.',
      label: 'Stopped',
      state: 'stopped',
    },
  ];

export function nativePrototypeCapabilities(
  mode: NativePrototypeSurfaceMode
): NativePrototypeCapabilities {
  if (mode === 'local') {
    return {
      annotations: true,
      codexFeedback: true,
      hostAccess: false,
      readOnly: false,
    };
  }
  return {
    annotations: false,
    codexFeedback: false,
    hostAccess: false,
    readOnly: true,
  };
}

export function nativePrototypePrimaryAction(state: PrototypeLaunchState) {
  switch (state) {
    case 'not-started':
      return { disabled: false, label: 'Start prototype' } as const;
    case 'starting':
      return { disabled: true, label: 'Starting prototype' } as const;
    case 'ready':
      return { disabled: false, label: 'Open prototype' } as const;
    case 'stale':
      return { disabled: false, label: 'Reconnect exact head' } as const;
    case 'unavailable':
      return { disabled: false, label: 'Retry prototype' } as const;
    case 'stopped':
      return { disabled: false, label: 'Restart prototype' } as const;
  }
}

export function nativePrototypeScenarioState(
  scenarioId: string
): PrototypeLaunchState {
  switch (scenarioId) {
    case 'empty':
      return 'not-started';
    case 'loading':
      return 'starting';
    case 'error':
      return 'unavailable';
    case 'long-content':
      return 'stale';
    case 'dark-theme':
    case 'light-theme':
    case 'populated':
    default:
      return 'ready';
  }
}

export function nativePrototypeStateDescription(state: PrototypeLaunchState) {
  return (
    NATIVE_PROTOTYPE_STATE_OPTIONS.find((option) => option.state === state)
      ?.description ?? ''
  );
}

export function shortNativePrototypeSha(headSha: string) {
  return headSha.slice(0, 7);
}

export function nativePrototypeIdentityFromUrl(
  value: string | undefined
): PrototypeLaunchIdentity | undefined {
  if (!value) return undefined;
  let search: string;
  try {
    search = new URL(value, 'https://projects.os-home.net').search;
  } catch {
    return undefined;
  }
  const identity = parsePrototypeLaunchRouteIdentity(search);
  if (
    !identity.headSha ||
    !identity.projectId ||
    !identity.pullRequestNumber ||
    !identity.repositoryFullName ||
    identity.surface !== 'mobile-prototype'
  ) {
    return undefined;
  }
  return identity as PrototypeLaunchIdentity;
}
