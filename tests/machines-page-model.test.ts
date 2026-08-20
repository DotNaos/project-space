import { describe, expect, it } from 'bun:test';
import {
  computeSourceSections,
  countComputeSourceRows,
  filterComputeSourceSections
} from '../src/features/project-desktop/components/machines-page-model';
import type { TailscaleInventoryDevice } from '../src/shared/tailscale-inventory-api';
import type { GitHubCodespaceInventoryItem } from '../src/shared/github-codespace-inventory-api';

const tailscaleDevice: TailscaleInventoryDevice = {
  addresses: ['100.64.0.12', 'fd7a:115c:a1e0::12'],
  classification: 'environment',
  id: 'device-12',
  name: 'os-pc',
  network: {
    checkedAt: '2026-08-16T12:00:00.000Z',
    freshUntil: '2026-08-16T12:01:00.000Z',
    state: 'online'
  },
  os: 'linux',
  revision: 3,
  tags: ['tag:workstation']
};

const codespace: GitHubCodespaceInventoryItem = {
  createdAt: '2026-08-15T12:00:00.000Z',
  displayName: '#732 Compute redesign',
  name: 'probable-space-lamp',
  ref: 'refs/heads/issue-732-redesign-compute-page',
  repositoryFullName: 'DotNaos/project-space',
  state: 'Available',
  url: 'https://example.test/codespaces/probable-space-lamp'
};

describe('source-first Compute page model', () => {
  it('keeps the fixed source order and stable provider identities', () => {
    const sections = computeSourceSections({ codespaces: [codespace], tailscaleDevices: [tailscaleDevice] });

    expect(sections.map((section) => section.label)).toEqual(['Tailscale', 'GitHub Codespaces']);
    expect(sections[0]!.rows[0]!.id).toBe('tailscale:device-12');
    expect(sections[1]!.rows[0]!.id).toBe('github:probable-space-lamp');
    expect(countComputeSourceRows(sections)).toBe(2);
  });

  it('keeps exact Tailscale addresses as row truth', () => {
    const [section] = computeSourceSections({ tailscaleDevices: [tailscaleDevice] });
    const row = section!.rows[0]!;

    expect(row.kind).toBe('tailscale');
    if (row.kind !== 'tailscale') throw new Error('Expected a Tailscale row.');
    expect(row.record.addresses).toEqual(['100.64.0.12', 'fd7a:115c:a1e0::12']);
    expect(row.status).toBe('available');
  });

  it('uses native GitHub lifecycle state rather than generic host state', () => {
    const sections = computeSourceSections({
      codespaces: [{ ...codespace, state: 'Shutdown' }]
    });

    expect(sections[1]!.rows[0]!.status).toBe('attention');
    expect(sections[1]!.rows[0]!.searchTerms).toContain('Shutdown');
  });

  it('deduplicates provider records by their stable source identity', () => {
    const sections = computeSourceSections({
      tailscaleDevices: [tailscaleDevice, { ...tailscaleDevice, name: 'duplicate' }],
      codespaces: [codespace, { ...codespace, displayName: 'duplicate' }]
    });

    expect(sections[0]!.rows.map((row) => row.id)).toEqual(['tailscale:device-12']);
    expect(sections[1]!.rows.map((row) => row.id)).toEqual(['github:probable-space-lamp']);
    expect(countComputeSourceRows(sections)).toBe(2);
  });

  it('searches both providers while preserving both source sections', () => {
    const sections = computeSourceSections({ codespaces: [codespace], tailscaleDevices: [tailscaleDevice] });

    const byAddress = filterComputeSourceSections(sections, '100.64.0.12', 'all');
    expect(byAddress.map((section) => section.rows.length)).toEqual([1, 0]);

    const byRepository = filterComputeSourceSections(sections, 'project-space', 'all');
    expect(byRepository.map((section) => section.rows.length)).toEqual([0, 1]);

    const available = filterComputeSourceSections(sections, '', 'available');
    expect(available.map((section) => section.rows.length)).toEqual([1, 1]);
  });
});
