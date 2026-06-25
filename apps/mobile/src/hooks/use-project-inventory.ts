import { useCallback, useEffect, useState } from 'react';

import {
  PROJECT_INVENTORY,
  type ProjectInventory,
} from '../data/project-inventory';

const inventoryUrl = process.env.EXPO_PUBLIC_PROJECT_SPACE_INVENTORY_URL ?? '';

async function fetchRemoteInventory(url: string): Promise<ProjectInventory> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Inventory request failed with ${response.status}.`);
  }

  return (await response.json()) as ProjectInventory;
}

export function useProjectInventory() {
  const [inventory, setInventory] = useState(PROJECT_INVENTORY);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sourceLabel, setSourceLabel] = useState(
    inventoryUrl ? 'Bundled snapshot' : 'Bundled snapshot'
  );

  const refresh = useCallback(async () => {
    if (!inventoryUrl) {
      setSourceLabel('Bundled snapshot');
      setErrorMessage(null);
      return;
    }

    setIsRefreshing(true);
    setErrorMessage(null);

    try {
      const nextInventory = await fetchRemoteInventory(inventoryUrl);
      setInventory(nextInventory);
      setSourceLabel('VPS inventory');
    } catch (error) {
      setSourceLabel('Bundled snapshot');
      setErrorMessage(
        error instanceof Error ? error.message : 'Could not refresh the VPS inventory.'
      );
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    errorMessage,
    inventory,
    isRefreshing,
    refresh,
    sourceLabel,
  };
}
