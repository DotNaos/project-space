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
import type { CodexHostInventoryItem } from '@/shared/codex-host-inventory-api';
import type { ProjectSpaceRecord, ProjectWorktreeRecord } from '@/shared/project-space-api';
import type { CodexSessionsController } from './codex-sessions-controller';
import type { CodexThreadOrigin } from './codex-sessions-types';

export function CodexThreadCreateDialog({
  controller,
  isOpen,
  issueNumber,
  onCreated,
  onOpenChange,
  project,
  suppliedHosts
}: {
  controller: CodexSessionsController;
  isOpen: boolean;
  issueNumber?: number;
  onCreated(origin: CodexThreadOrigin): void;
  onOpenChange(isOpen: boolean): void;
  project?: ProjectSpaceRecord;
  suppliedHosts?: readonly CodexHostInventoryItem[];
}) {
  const [hosts, setHosts] = useState<CodexHostInventoryItem[]>([]);
  const [machineId, setMachineId] = useState<string | null>(null);
  const [worktreeId, setWorktreeId] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<ProjectWorktreeRecord[]>([]);
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [loadingWorktrees, setLoadingWorktrees] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const selectedWorktree = useMemo(
    () => worktrees.find((worktree) => worktree.id === worktreeId),
    [worktreeId, worktrees]
  );
  const selectedHost = useMemo(
    () => hosts.find((host) => host.machineId === machineId),
    [hosts, machineId]
  );

  useEffect(() => {
    if (!isOpen) {
      setMachineId(null);
      setWorktreeId(null);
      setWorktrees([]);
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
    if (!isOpen || !project || typeof machineId !== 'string') {
      setWorktrees([]);
      setWorktreeId(null);
      return;
    }
    let active = true;
    setLoadingWorktrees(true);
    setWorktreeId(null);
    setError('');
    void projectSpaceClient.loadProjectWorktrees(project.id, machineId)
      .then((result) => result.filter((worktree) => worktree.status === 'ready'))
      .then((result) => {
        if (!active) return;
        setWorktrees(result);
        setWorktreeId(result[0]?.id ?? null);
      })
      .catch(() => {
        if (active) {
          setWorktrees([]);
          setError('Worktrees for this machine could not be loaded.');
        }
      })
      .finally(() => {
        if (active) setLoadingWorktrees(false);
      });
    return () => { active = false; };
  }, [isOpen, machineId, project]);

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

  const pending = loadingHosts || loadingWorktrees || creating;

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

            <Select
              fullWidth
              isDisabled={pending || !project || worktrees.length === 0}
              onChange={(value) => setWorktreeId(typeof value === 'string' ? value : null)}
              placeholder={loadingWorktrees ? 'Loading worktrees…' : 'Select a worktree'}
              value={worktreeId}
              variant="secondary"
            >
              <Label>Worktree</Label>
              <Select.Trigger className="min-w-0 overflow-hidden">
                <Select.Value className="min-w-0 flex-1 overflow-hidden">
                  {({ defaultChildren, isPlaceholder }) => isPlaceholder || !selectedWorktree ? defaultChildren : (
                    <span className="flex min-w-0 items-center gap-2">
                      <FolderGit2 className="size-4 shrink-0 text-neutral-500" />
                      <span className="w-0 flex-1 truncate">{selectedWorktree.name}</span>
                    </span>
                  )}
                </Select.Value>
                <Select.Indicator className="shrink-0" />
              </Select.Trigger>
              <Select.Popover className="rounded-lg border border-neutral-800 bg-neutral-950">
                <ListBox>
                  {worktrees.map((worktree) => (
                    <ListBox.Item id={worktree.id} key={worktree.id} textValue={worktree.name}>
                      <span className="flex min-w-0 items-center gap-2">
                        <FolderGit2 className="size-4 shrink-0 text-neutral-500" />
                        <span className="min-w-0">
                          <span className="block truncate">{worktree.name}</span>
                          {worktree.branchName ? (
                            <span className="block truncate text-[10px] text-neutral-500">
                              {worktree.branchName}
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

            {error ? <p className="text-xs leading-5 text-red-300">{error}</p> : null}
            {!loadingHosts && hosts.length === 0 && !error ? (
              <p className="text-xs leading-5 text-neutral-500">No online Codex machine is available.</p>
            ) : null}
            {!loadingWorktrees && machineId && worktrees.length === 0 && !error ? (
              <p className="text-xs leading-5 text-neutral-500">No ready worktree is available on this machine.</p>
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
