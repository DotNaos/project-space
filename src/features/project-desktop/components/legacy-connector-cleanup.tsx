import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Chip, Dialog, Icon, Spinner } from '@dotnaos/ui/base';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  LegacyConnectorCleanupBlocker,
  LegacyConnectorCleanupRecord,
  LegacyConnectorCleanupSnapshot,
  LegacyConnectorRemovalResult
} from '@/shared/legacy-connector-cleanup-api';

export const legacyConnectorRemovalScope = 'Project Space legacy records only. No Tailscale device, physical machine, provider resource, deployment target, or canonical Environment is deleted.';

function requestId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('This browser cannot create a secure cleanup request identifier.');
  }
  return `legacy-connector-cleanup:${globalThis.crypto.randomUUID()}`;
}

function blockerLabel(blocker: LegacyConnectorCleanupBlocker) {
  const labels: Record<LegacyConnectorCleanupBlocker['kind'], string> = {
    active_credential: 'Active credential',
    active_operation: 'Active control operation',
    access_route: 'Access route',
    codex_route: 'Codex route',
    codex_snapshot: 'Codex snapshot',
    connector_operation: 'Connector operation',
    dev_server: 'Development server',
    execution_scope: 'Execution scope',
    environment_reference: 'Nested Environment',
    host_agent: 'Host agent',
    physical_host_mapping: 'Physical Host mapping',
    run_destination: 'Task run destination',
    task_execution: 'Task execution',
    workspace_command: 'Workspace command',
    workspace_runtime: 'Workspace Runtime'
  };
  return `${labels[blocker.kind]} · ${blocker.count} ${blocker.count === 1 ? 'reference' : 'references'}`;
}

export function cleanupOutcomeLabel(outcome: LegacyConnectorRemovalResult['results'][number]['outcome']) {
  switch (outcome) {
    case 'removed': return 'Removed';
    case 'already_removed': return 'Already removed';
    case 'blocked': return 'Blocked';
    case 'conflict': return 'Changed before removal';
  }
}

export function eligibleCleanupRecords(
  records: readonly LegacyConnectorCleanupRecord[],
  connectorIds: ReadonlySet<string>
) {
  return records.filter((record) => record.eligible && connectorIds.has(record.connectorId));
}

export function defaultCleanupSelection(records: readonly LegacyConnectorCleanupRecord[]) {
  return new Set(records.filter((record) => record.eligible).map((record) => record.connectorId));
}

export function cleanupRemovalRecords(records: readonly LegacyConnectorCleanupRecord[]) {
  return records.map(({ connectorId, fingerprint }) => ({ connectorId, fingerprint }));
}

function replacementLabel(record: LegacyConnectorCleanupRecord) {
  if (!record.replacement) return undefined;
  return record.replacement.kind === 'tailscale'
    ? 'Canonical Tailscale Environment'
    : 'Canonical provider Environment';
}

function outcomeFor(
  record: LegacyConnectorCleanupRecord,
  result: LegacyConnectorRemovalResult | undefined
) {
  return result?.results.find((entry) => entry.connectorId === record.connectorId);
}

function cleanupRecordState(
  record: LegacyConnectorCleanupRecord,
  result: LegacyConnectorRemovalResult | undefined
) {
  const outcome = outcomeFor(record, result);
  if (outcome) return cleanupOutcomeLabel(outcome.outcome);
  return record.eligible ? 'Eligible' : 'Blocked';
}

function CleanupRecordRow({
  onRemove,
  onSelectedChange,
  record,
  result,
  selected
}: {
  onRemove(record: LegacyConnectorCleanupRecord): void;
  onSelectedChange(record: LegacyConnectorCleanupRecord, selected: boolean): void;
  record: LegacyConnectorCleanupRecord;
  result?: LegacyConnectorRemovalResult;
  selected: boolean;
}) {
  const outcome = outcomeFor(record, result);
  const retryable = record.eligible && (outcome?.outcome === 'blocked' || outcome?.outcome === 'conflict');
  const removable = record.eligible && (!outcome || retryable);
  const replacement = replacementLabel(record);
  const blockers = outcome?.blockers ?? record.blockers;

  return (
    <li className="border-b border-neutral-800/70 py-3 last:border-b-0">
      <div className="flex min-w-0 items-start gap-3">
        <Checkbox
          checked={selected}
          disabled={!removable}
          label={`Select ${record.label}`}
          onCheckedChange={(nextSelected) => onSelectedChange(record, nextSelected)}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-neutral-100">{record.label}</span>
          <span className="mt-1 block text-xs text-neutral-500">{replacement ?? 'No canonical replacement is recorded.'}</span>
          {blockers.length > 0 ? (
            <span className="mt-2 flex flex-wrap gap-1.5">
              {blockers.map((blocker) => <Chip key={blocker.kind} label={blockerLabel(blocker)} size="sm" tone="warning" variant="soft" />)}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Chip
            label={cleanupRecordState(record, result)}
            size="sm"
            tone={outcome?.outcome === 'removed' || outcome?.outcome === 'already_removed' ? 'success' : removable ? 'accent' : 'warning'}
            variant="soft"
          />
          {removable ? (
            <Button icon="trash" label={retryable ? 'Retry' : 'Remove'} variant="ghost" onPress={() => onRemove(record)} />
          ) : null}
        </span>
      </div>
    </li>
  );
}

export function LegacyConnectorCleanup({
  initialSnapshot,
  onChanged
}: {
  initialSnapshot?: LegacyConnectorCleanupSnapshot;
  onChanged(): Promise<unknown>;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmRecords, setConfirmRecords] = useState<readonly LegacyConnectorCleanupRecord[]>([]);
  const [result, setResult] = useState<LegacyConnectorRemovalResult>();
  const [resultLabels, setResultLabels] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(!initialSnapshot);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await projectSpaceClient.getLegacyConnectorCleanup();
      setSnapshot(next);
      setSelected(defaultCleanupSelection(next.records));
    } catch {
      // The cleanup control is deliberately absent when the owner-only preflight cannot be trusted.
      setSnapshot(undefined);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialSnapshot) void load();
  }, [initialSnapshot, load]);

  const selectedRecords = useMemo(
    () => eligibleCleanupRecords(snapshot?.records ?? [], selected),
    [selected, snapshot]
  );
  const hasRecords = Boolean(snapshot?.records.length);

  const changeSelection = useCallback((record: LegacyConnectorCleanupRecord, nextSelected: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (nextSelected && record.eligible) next.add(record.connectorId);
      else next.delete(record.connectorId);
      return next;
    });
  }, []);

  const remove = useCallback(async () => {
    if (confirmRecords.length === 0) return;
    setRemoving(true);
    setError('');
    try {
      const nextResult = await projectSpaceClient.removeLegacyConnectors(
        cleanupRemovalRecords(confirmRecords),
        requestId()
      );
      setResultLabels(Object.fromEntries(confirmRecords.map((record) => [record.connectorId, record.label])));
      setResult(nextResult);
      setConfirmRecords([]);
      if (nextResult.results.some((entry) => entry.outcome === 'removed' || entry.outcome === 'already_removed')) {
        await Promise.all([load(), onChanged()]);
      }
    } catch {
      setError('The records were not removed. Refresh the review before trying again.');
    } finally {
      setRemoving(false);
    }
  }, [confirmRecords, load, onChanged]);

  if (!hasRecords && !reviewOpen) return null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-neutral-800/70 pt-3">
      {hasRecords ? (
        <>
          <span className="text-xs text-neutral-500">Legacy records · {snapshot!.records.length}</span>
          <Button disabled={loading} label="Review" variant="ghost" onPress={() => { setResult(undefined); setResultLabels({}); setReviewOpen(true); }} />
        </>
      ) : null}

      <Dialog.Surface
        closeLabel="Close legacy record review"
        closeOnBackdrop={!removing}
        label="Review legacy Connector records"
        onClose={() => { if (!removing) setReviewOpen(false); }}
        open={reviewOpen}
        width="large"
      >
        <Dialog.Header>
          <div>
            <h2 className="text-base font-semibold text-neutral-100">Review legacy Connector records</h2>
            <p className="mt-1 text-xs leading-5 text-neutral-500">{legacyConnectorRemovalScope}</p>
          </div>
        </Dialog.Header>
        <div className="max-h-[60vh] overflow-y-auto px-1 py-2">
          {result ? (
            <div role="status" className="border-b border-neutral-800/70 py-3 text-xs text-neutral-400">
              {result.results.map((entry) => {
                const record = snapshot?.records.find((candidate) => candidate.connectorId === entry.connectorId)
                  ?? confirmRecords.find((candidate) => candidate.connectorId === entry.connectorId);
                return <span key={entry.connectorId} className="block">{record?.label ?? resultLabels[entry.connectorId] ?? 'Legacy record'} · {cleanupOutcomeLabel(entry.outcome)}</span>;
              })}
            </div>
          ) : null}
          {snapshot?.records.length ? (
            <ul aria-label="Legacy Connector records" className="divide-y divide-neutral-800/70">
              {snapshot.records.map((record) => (
                <CleanupRecordRow
                  key={record.connectorId}
                  onRemove={(nextRecord) => setConfirmRecords([nextRecord])}
                  onSelectedChange={changeSelection}
                  record={record}
                  result={result}
                  selected={selected.has(record.connectorId)}
                />
              ))}
            </ul>
          ) : (
            <div className="py-8 text-center">
              <Icon name="check" color="success" />
              <p className="mt-2 text-sm text-neutral-400">No legacy Connector records remain.</p>
            </div>
          )}
          {error ? <p role="alert" className="py-3 text-xs text-red-300">{error}</p> : null}
        </div>
        <Dialog.Footer>
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-neutral-500">{selectedRecords.length} eligible selected</span>
            <div className="flex items-center gap-2">
              <Button disabled={removing} label="Done" variant="ghost" onPress={() => setReviewOpen(false)} />
              <Button disabled={removing || selectedRecords.length === 0} icon="trash" label="Remove eligible" variant="primary" onPress={() => setConfirmRecords(selectedRecords)} />
            </div>
          </div>
        </Dialog.Footer>
      </Dialog.Surface>

      <Dialog.Surface
        closeLabel="Cancel legacy record removal"
        closeOnBackdrop={false}
        label="Confirm legacy record removal"
        onClose={() => { if (!removing) setConfirmRecords([]); }}
        open={confirmRecords.length > 0}
        width="medium"
      >
        <Dialog.Header>
          <div className="flex items-center gap-3">
            <Icon name="alert-triangle" color="warning" />
            <h2 className="text-base font-semibold text-neutral-100">Remove {confirmRecords.length === 1 ? 'this legacy record' : `${confirmRecords.length} legacy records`}?</h2>
          </div>
        </Dialog.Header>
        <div>
          <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-neutral-200">
            {confirmRecords.map((record) => <li key={record.connectorId}>{record.label}</li>)}
          </ul>
          <p className="text-sm leading-6 text-neutral-300">{legacyConnectorRemovalScope}</p>
        </div>
        <Dialog.Footer>
          <div className="flex w-full flex-col-reverse gap-2 min-[420px]:flex-row min-[420px]:justify-end">
            <Button disabled={removing} label="Cancel" variant="ghost" onPress={() => setConfirmRecords([])} />
            {removing ? <Spinner size="s" /> : null}
            <Button disabled={removing} icon="trash" label={removing ? 'Removing…' : 'Remove records'} variant="primary" onPress={() => void remove()} />
          </div>
        </Dialog.Footer>
      </Dialog.Surface>
    </div>
  );
}
