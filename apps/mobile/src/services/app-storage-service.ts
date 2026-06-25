import AsyncStorage from '@react-native-async-storage/async-storage';

import type { PersistedAppState } from '../domain/models';

const storageKey = 'project-space-mobile.state.v1';

const defaultState: PersistedAppState = {
  authSession: null,
  selectedProjects: [],
  ideasByRepositoryId: {},
};

export async function loadPersistedAppState(): Promise<PersistedAppState> {
  const rawValue = await AsyncStorage.getItem(storageKey);

  if (!rawValue) {
    return defaultState;
  }

  try {
    return {
      ...defaultState,
      ...(JSON.parse(rawValue) as PersistedAppState),
    };
  } catch {
    return defaultState;
  }
}

export async function persistAppState(state: PersistedAppState) {
  await AsyncStorage.setItem(storageKey, JSON.stringify(state));
}

export async function clearPersistedAppState() {
  await AsyncStorage.removeItem(storageKey);
}
