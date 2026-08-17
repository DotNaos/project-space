import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Label,
  ListBox,
  Modal,
  Select,
  Spinner
} from '@heroui/react';
import { Bot, FolderGit2 } from 'lucide-react';
import { projectSpaceClient } from '@/api/project-space-client';
import type {
  CodexHostInventoryItem,
  CodexHostWorktree
} from '@/shared/codex-host-inventory-api';
import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import type { CodexSessionsController } from './codex-sessions-controller';
import type { CodexThreadOrigin } from './codex-sessions-types';
import {
  codexHostWorktrees,
  issueBoundCodexWorktree,
  type IssueWorktreeBinding
} from './codex-thread-create-model';

export function CodexThreadCreateDialog({
  controller,
  isOpen,
  issueNumber,
  onCreated,
  onOpenChange,
  project,
  suppliedHosts,
  taskBinding
}: {
  controller: CodexSessionsController;
  isOpen: boolean;
  issueNumber?: number;
  onCreated(origin: CodexThreadOrigin): void;
  onOpenChange(isOpen: boolean): void;
  project?: ProjectSpaceRecord;
  suppliedHosts?: readonly CodexHostInventoryItem[];
  taskBinding?: IssueWorktreeBinding;
}) {
  const [hosts, setHosts] = useState<CodexHostInventoryItem[]>([]);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const issueBranch = taskBinding?.branch;
  const issueNumberBinding = taskBinding?.issueNumber;
  const issueRepository = taskBinding?.repository;
  const stableTaskBinding = useMemo<IssueWorktreeBinding | undefined>(() => (
    issueNumberBinding && issueRepository
      ? {
          ...(issueBranch ? { branch: issueBranch } : {}),
          issueNumber: issueNumberBinding,
          repository: issueRepository
        }
      : undefined
  ), [issueBranch, issueNumberBinding, issueRepository]);
  const selectedHost = useMemo(
    () => hosts.find((host) => host.machineId === machineId),
    [hosts, machineId]
  );
  const worktrees = useMemo(
    () => codexHostWorktrees(selectedHost, stableTaskBinding),
    [selectedHost, stableTaskBinding]
  );
  const selectedWorktree = useMemo<CodexHostWorktree | undefined>(() => (
    stableTaskBinding
      ? issueBoundCodexWorktree(selectedHost, stableTaskBinding)
      : worktrees.find((worktree) => worktree.path === worktreePath)
  ), [selectedHost, stableTaskBinding, worktreePath, worktrees]);

  useEffect(() => {
    if (!isOpen) {
      setMachineId(null);
      setWorktreePath(null);
      setError('');
      return;
    }
    let active = true;
    setLoadingHosts(true);
    setError('');
    const request = suppliedHosts
      ? Promise.resolve([...suppliedHosts])
      : projectSpaceClient.getTailscaleInventory(true)
        .then(() => projectSpaceClient.getCodexHostInventory())
        .then((result) => result.hosts);
    void request.then((result) => {
      if (!active) return;
      setHosts(result);
      setMachineId((current) => current ?? result[0]?.machineId ?? null);
    }).catch(() => {
      if (active) setError('Online Codex machines could not be loaded.');
    }).finally(() => {
      if (active) setLoadingHosts(false);
    });
    return () => { active = false; };
  }, [isOpen, suppliedHosts]);

  useEffect(() => {
    setWorktreePath(stableTaskBinding ? null : worktrees[0]?.path ?? null);
  }, [stableTaskBinding, worktrees]);

  async function createThread() {
    if (typeof machineId !== 'string' || !selectedWorktree || creating) return;
    setCreating(true);
    setError('');
    try {
      const origin = await controller.start(machineId, selectedWorktree.path);
      onOpenChange(false);
      onCreated(origin);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The Codex task could not be created.');
    } finally {
      setCreating(false);
    }
  }

  const pending = loadingHosts || creating;

  return (
    <Modal.Backdrop
      className="z-[140] bg-black/70"
      isDismissable={!creating}
      isKeyboardDismissDisabled={creating}
      isOpen={isOpen}
      onOpenChange={(nextOpen) => {
        if (nextOpen || !creating) onOpenChange(nextOpen);
      }}
      variant="blur"
    >
      <Modal.Container className="p-4" placement="center" size="sm">
        <Modal.Dialog className="bg-app-panel text-neutral-100 sm:max-w-[420px]">
          {!creating ? <Modal.CloseTrigger aria-label="Close new Codex task" /> : null}
          <Modal.Header className="items-start text-left">
            <Modal.Icon className="bg-blue-500/15 text-blue-300">
              <Bot className="size-5" />
            </Modal.Icon>
            <Modal.Heading>New Codex task</Modal.Heading>
            <p className="text-xs text-neutral-500">
              {project?.name ?? 'Select a project in the sidebar'}
              {issueNumber ? ` · Issue #${issueNumber}` : ''}
            </p>
          </Modal.Header>
          <Modal.Body className="grid gap-4 !overflow-visible">
            <Select
              fullWidth
              isDisabled={pending || hosts.length === 0}
              onChange={(value) => setMachineId(typeof value === 'string' ? value : null)}
              placeholder={loadingHosts ? 'Loading machines…' : 'Select a machine'}
              value={machineId}
              variant="secondary"
            >
              <Label>Machine</Label>
              <Select.Trigger className="min-w-0 overflow-hidden">
                <Select.Value className="min-w-0 flex-1 overflow-hidden">
                  {({ defaultChildren, isPlaceholder }) => isPlaceholder || !selectedHost ? defaultChildren : (
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
                      <span className="w-0 flex-1 truncate">{selectedHost.name}</span>
                    </span>
                  )}
                </Select.Value>
                <Select.Indicator className="shrink-0" />
              </Select.Trigger>
              <Select.Popover className="rounded-lg border border-neutral-800 bg-neutral-950">
                <ListBox>
                  {hosts.map((host) => (
                    <ListBox.Item id={host.machineId} key={host.machineId} textValue={host.name}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="size-2 shrink-0 rounded-full bg-emerald-400" />
                        <span className="truncate">{host.name}</span>
                      </span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>

            {taskBinding ? (
              <div aria-label="Task worktree" className="grid gap-1.5">
                <span className="text-sm font-medium text-neutral-300">Task worktree</span>
                <div className="flex min-h-10 min-w-0 items-center gap-2 rounded-xl bg-neutral-900 px-3 py-2 text-sm">
                  <FolderGit2 className="size-4 shrink-0 text-neutral-500" />
                  <span className="min-w-0 flex-1 truncate">
                    {selectedWorktree?.branch ?? selectedWorktree?.label ?? taskBinding.branch ?? `Issue #${taskBinding.issueNumber}`}
                  </span>
                </div>
                <p className="text-[11px] leading-4 text-neutral-500">
                  This task always uses its own assigned worktree.
                </p>
              </div>
            ) : (
              <Select
                fullWidth
                isDisabled={pending || !project || worktrees.length === 0}
                onChange={(value) => setWorktreePath(typeof value === 'string' ? value : null)}
                placeholder="Select a worktree"
                value={worktreePath}
                variant="secondary"
              >
                <Label>Worktree</Label>
                <Select.Trigger className="min-w-0 overflow-hidden">
                  <Select.Value className="min-w-0 flex-1 overflow-hidden">
                    {({ defaultChildren, isPlaceholder }) => isPlaceholder || !selectedWorktree ? defaultChildren : (
                      <span className="flex min-w-0 items-center gap-2">
                        <FolderGit2 className="size-4 shrink-0 text-neutral-500" />
                        <span className="w-0 flex-1 truncate">{selectedWorktree.label}</span>
                      </span>
                    )}
                  </Select.Value>
                  <Select.Indicator className="shrink-0" />
                </Select.Trigger>
                <Select.Popover className="rounded-lg border border-neutral-800 bg-neutral-950">
                  <ListBox>
                    {worktrees.map((worktree) => (
                      <ListBox.Item id={worktree.path} key={worktree.path} textValue={worktree.label}>
                        <span className="flex min-w-0 items-center gap-2">
                          <FolderGit2 className="size-4 shrink-0 text-neutral-500" />
                          <span className="min-w-0">
                            <span className="block truncate">{worktree.label}</span>
                            {worktree.branch ? (
                              <span className="block truncate text-[10px] text-neutral-500">
                                {worktree.branch}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            )}

            {error ? <p className="text-xs leading-5 text-red-300">{error}</p> : null}
            {!loadingHosts && hosts.length === 0 && !error ? (
              <p className="text-xs leading-5 text-neutral-500">No online Codex machine is available.</p>
            ) : null}
            {machineId && worktrees.length === 0 && !error ? (
              <p className="text-xs leading-5 text-neutral-500">
                {taskBinding
                  ? 'This task’s assigned worktree is not available on the selected machine.'
                  : 'No ready worktree is available on this machine.'}
              </p>
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button isDisabled={creating} onPress={() => onOpenChange(false)} variant="secondary">
              Cancel
            </Button>
            <Button
              isDisabled={!project || typeof machineId !== 'string' || !selectedWorktree || pending}
              onPress={() => void createThread()}
            >
              {creating ? <Spinner size="sm" /> : <Bot className="size-4" />}
              {creating ? 'Creating…' : 'Create task'}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
