import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertDialog, Checkbox, Modal } from '@heroui/react';
import { AlertTriangle, Check, LoaderCircle, Trash2 } from 'lucide-react';
import { Button, Chip, Text } from '@/app/dotnaos-ui';
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
          aria-label={`Select ${record.label}`}
          className="mt-0.5 shrink-0"
          isDisabled={!removable}
          isSelected={selected}
          onChange={(nextSelected) => onSelectedChange(record, nextSelected)}
        >
          <Checkbox.Content>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <span className="sr-only">Select {record.label}</span>
          </Checkbox.Content>
        </Checkbox>
        <span className="min-w-0 flex-1">
          <Text className="block truncate text-sm font-medium text-neutral-100">{record.label}</Text>
          <Text className="mt-1 block text-xs text-neutral-500">
            {replacement ?? 'No canonical replacement is recorded.'}
          </Text>
          {blockers.length > 0 ? (
            <span className="mt-2 flex flex-wrap gap-1.5">
              {blockers.map((blocker) => <Chip key={blocker.kind} size="sm" className="text-amber-300">{blockerLabel(blocker)}</Chip>)}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Chip size="sm" className={outcome?.outcome === 'removed' || outcome?.outcome === 'already_removed' ? 'text-emerald-300' : removable ? 'text-sky-300' : 'text-amber-300'}>
            {cleanupRecordState(record, result)}
          </Chip>
          {removable ? (
            <Button size="sm" variant="ghost" onPress={() => onRemove(record)}>
              <Trash2 className="size-3.5" />{retryable ? 'Retry' : 'Remove'}
            </Button>
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
          <Text className="text-xs text-neutral-500">Legacy records · {snapshot!.records.length}</Text>
          <Button size="sm" variant="ghost" isDisabled={loading} onPress={() => { setResult(undefined); setResultLabels({}); setReviewOpen(true); }}>
            Review
          </Button>
        </>
      ) : null}

      <Modal isOpen={reviewOpen} onOpenChange={(open) => { if (!removing) setReviewOpen(open); }}>
        <Modal.Backdrop variant="blur" className="z-[120] bg-black/75">
          <Modal.Container placement="auto" scroll="inside" size="md" className="p-3 sm:p-5">
            <Modal.Dialog className="overflow-hidden border border-neutral-800 bg-neutral-950 text-neutral-100 shadow-2xl shadow-black/70 sm:max-w-2xl">
              <Modal.Header className="items-start border-b border-neutral-800 px-5 py-4 sm:px-6">
                <span className="min-w-0 flex-1">
                  <Modal.Heading className="text-base font-semibold">Review legacy Connector records</Modal.Heading>
                  <Text className="mt-1 block text-xs leading-5 text-neutral-500">{legacyConnectorRemovalScope}</Text>
                </span>
                {!removing ? <Modal.CloseTrigger aria-label="Close legacy record review" className="text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" /> : null}
              </Modal.Header>
              <Modal.Body className="px-5 py-2 sm:px-6">
                {result ? (
                  <div role="status" className="border-b border-neutral-800/70 py-3 text-xs text-neutral-400">
                    {result.results.map((entry) => {
                      const record = snapshot?.records.find((candidate) => candidate.connectorId === entry.connectorId)
                        ?? confirmRecords.find((candidate) => candidate.connectorId === entry.connectorId);
                      return <Text key={entry.connectorId} className="block">{record?.label ?? resultLabels[entry.connectorId] ?? 'Legacy record'} · {cleanupOutcomeLabel(entry.outcome)}</Text>;
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
                  <div className="py-8 text-center"><Check className="mx-auto size-5 text-emerald-300" /><Text className="mt-2 block text-sm text-neutral-400">No legacy Connector records remain.</Text></div>
                )}
                {error ? <Text role="alert" className="py-3 text-xs text-red-300">{error}</Text> : null}
              </Modal.Body>
              <Modal.Footer className="flex-row items-center justify-between border-t border-neutral-800 px-5 py-4 sm:px-6">
                <Text className="text-xs text-neutral-500">{selectedRecords.length} eligible selected</Text>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" isDisabled={removing} onPress={() => setReviewOpen(false)}>Done</Button>
                  <Button size="sm" variant="danger" isDisabled={removing || selectedRecords.length === 0} onPress={() => setConfirmRecords(selectedRecords)}>
                    <Trash2 className="size-3.5" />Remove eligible
                  </Button>
                </div>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      <AlertDialog isOpen={confirmRecords.length > 0} onOpenChange={(open) => {
        if (!open && !removing) setConfirmRecords([]);
      }}>
        <AlertDialog.Backdrop isDismissable={false} isKeyboardDismissDisabled={removing} variant="blur" className="z-[130] bg-black/80">
          <AlertDialog.Container placement="center" size="md" className="px-3 py-3 sm:px-5 sm:py-6">
            <AlertDialog.Dialog className="border border-neutral-800 bg-neutral-950 text-neutral-100">
              <AlertDialog.Header>
                <AlertDialog.Icon status="warning"><AlertTriangle className="size-5" /></AlertDialog.Icon>
                <AlertDialog.Heading>Remove {confirmRecords.length === 1 ? 'this legacy record' : `${confirmRecords.length} legacy records`}?</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <ul className="mb-3 list-disc space-y-1 pl-5 text-sm text-neutral-200">
                  {confirmRecords.map((record) => <li key={record.connectorId}>{record.label}</li>)}
                </ul>
                <Text className="block text-sm leading-6 text-neutral-300">{legacyConnectorRemovalScope}</Text>
              </AlertDialog.Body>
              <AlertDialog.Footer className="flex-col-reverse gap-2 min-[420px]:flex-row min-[420px]:justify-end">
                <Button variant="ghost" isDisabled={removing} onPress={() => setConfirmRecords([])}>Cancel</Button>
                <Button variant="danger" isDisabled={removing} onPress={() => void remove()}>
                  {removing ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {removing ? 'Removing…' : 'Remove records'}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  );
}
