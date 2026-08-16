import type {
  LegacyConnectorCleanupSnapshot,
  LegacyConnectorRemovalRequest,
  LegacyConnectorRemovalResult
} from '../../src/shared/legacy-connector-cleanup-api';
import { PostgresLegacyConnectorCleanupStore } from './store';

export interface LegacyConnectorCleanupStore {
  listSnapshot(ownerUserId: string): Promise<LegacyConnectorCleanupSnapshot>;
  remove(ownerUserId: string, request: LegacyConnectorRemovalRequest): Promise<LegacyConnectorRemovalResult>;
}

export class LegacyConnectorCleanupService {
  constructor(private readonly store: LegacyConnectorCleanupStore) {}

  list(ownerUserId: string): Promise<LegacyConnectorCleanupSnapshot> {
    return this.store.listSnapshot(ownerUserId);
  }

  remove(ownerUserId: string, request: LegacyConnectorRemovalRequest): Promise<LegacyConnectorRemovalResult> {
    return this.store.remove(ownerUserId, request);
  }
}

export function createLegacyConnectorCleanupService(input: { store: LegacyConnectorCleanupStore }) {
  return new LegacyConnectorCleanupService(input.store);
}

export function createPostgresLegacyConnectorCleanupService(input: { store: PostgresLegacyConnectorCleanupStore }) {
  return createLegacyConnectorCleanupService(input);
}
