import { describe, expect, test } from 'bun:test';

import {
  connectorRemovalGate,
  connectorResponsibilityIds,
  connectorRetirementLedger
} from '../src/shared/connector-retirement-ledger';

describe('Connector retirement ledger', () => {
  test('accounts for every canonical Connector responsibility exactly once', () => {
    expect(connectorRetirementLedger.map(({ id }) => id).sort())
      .toEqual([...connectorResponsibilityIds].sort());
    expect(new Set(connectorRetirementLedger.map(({ id }) => id)).size)
      .toBe(connectorResponsibilityIds.length);
    expect(connectorRetirementLedger).toHaveLength(10);
  });

  test('binds every responsibility to a focused migration issue and concrete proof', () => {
    for (const entry of connectorRetirementLedger) {
      expect([646, 647, 648, 649]).toContain(entry.migrationIssue);
      expect(entry.replacementIssues).toContain(entry.migrationIssue);
      expect(entry.canonicalOwner.length).toBeGreaterThan(20);
      expect(entry.verification.length).toBeGreaterThan(20);
      expect(entry.rollback.length).toBeGreaterThan(20);
    }
  });

  test('keeps final removal blocked until runtime, rollback, and zero-use evidence exist', () => {
    expect(connectorRemovalGate.state).toBe('blocked');
    expect(connectorRemovalGate.finalRemovalIssue).toBe(650);
    expect(connectorRemovalGate.requiredEvidence).toContain('runtime_proof_complete');
    expect(connectorRemovalGate.requiredEvidence).toContain('rollback_drill_complete');
    expect(connectorRemovalGate.requiredEvidence)
      .toContain('zero_successful_legacy_use_for_full_window');
    expect(connectorRemovalGate.identityPolicy).toContain('never reinterpreted');
  });
});
