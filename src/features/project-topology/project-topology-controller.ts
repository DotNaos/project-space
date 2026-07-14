import {
  loadProjectTopologyInventory,
  loadProjectTopologyTaskDetails,
  withoutTopologyWriteCapabilities,
  type ProjectTopologySource
} from './project-topology-loader';
import { buildProjectTopology } from './project-topology-model';
import { applyTopologyBuild, beginTopologyRefresh } from './project-topology-refresh';
import {
  loadProjectTopologySelectedTask,
  topologyInventoryHasCurrentTask
} from './project-topology-selected-task-loader';
import type {
  ProjectTopologyInventory,
  ProjectTopologyReadState,
  TopologyTask
} from './project-topology-types';

export interface ProjectTopologyControllerOptions {
  clock?: () => string;
  includeTranscripts?: boolean;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

export class ProjectTopologyController {
  private abortController?: AbortController;
  private cancelAuthorityExpiry?: () => void;
  private disposed = false;
  private inventory?: ProjectTopologyInventory;
  private readonly listeners = new Set<() => void>();
  private refreshing = false;
  private requestVersion = 0;
  private selectedAbortController?: AbortController;
  private selectedTaskId?: string;
  private selectedVersion = 0;
  private state: ProjectTopologyReadState = { state: 'checking' };

  constructor(
    private readonly source: ProjectTopologySource,
    private readonly options: ProjectTopologyControllerOptions = {}
  ) {}

  getState = () => this.state;

  getSelectedTask = (taskId: string): TopologyTask | undefined => {
    if (
      this.disposed
      || this.selectedTaskId !== taskId
      || this.state.state !== 'ready'
    ) return undefined;
    for (const project of this.state.snapshot.projects) {
      for (const machine of project.machines) {
        const task = machine.tasks.find((candidate) => candidate.id === taskId);
        if (
          task?.evidence.current
          && task.interaction.composerVisible
          && task.interaction.authority
        ) return task;
      }
    }
    return undefined;
  };

  subscribe = (listener: () => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh() {
    if (this.disposed) return this.state;
    this.cancelSelectedTaskLoad();
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    const version = ++this.requestVersion;
    this.refreshing = true;
    this.inventory = undefined;
    this.update(beginTopologyRefresh(this.state));
    try {
      const inventory = await loadProjectTopologyInventory(this.source, {
        ...this.options,
        includeTranscripts: false,
        signal: abortController.signal
      });
      if (!this.isCurrent(version)) return this.state;
      this.inventory = inventory;
      const baseBuild = buildProjectTopology(inventory);
      this.update(applyTopologyBuild(this.state, baseBuild));
      if (baseBuild.state === 'ready' && this.options.includeTranscripts !== false) {
        const detailed = await loadProjectTopologyTaskDetails(
          this.source,
          inventory,
          { ...this.options, signal: abortController.signal }
        );
        if (!this.isCurrent(version)) return this.state;
        this.inventory = detailed;
        this.update(applyTopologyBuild(this.state, buildProjectTopology(detailed)));
      }
    } catch (error) {
      if (!this.isCurrent(version)) return this.state;
      this.inventory = undefined;
      this.update(applyTopologyBuild(this.state, {
        reason: errorMessage(error),
        state: 'blocked'
      }, this.now()));
    } finally {
      if (this.abortController === abortController) this.abortController = undefined;
      if (this.isCurrent(version)) this.refreshing = false;
    }
    const selectedTaskId = this.selectedTaskId;
    if (selectedTaskId && this.isCurrent(version) && this.state.state === 'ready') {
      await this.loadSelectedTask(selectedTaskId);
    }
    return this.state;
  }

  async selectTask(taskId?: string) {
    if (this.disposed) return this.state;
    this.selectedTaskId = taskId;
    this.cancelSelectedTaskLoad();
    if (this.inventory) {
      this.inventory = withoutTopologyWriteCapabilities(this.inventory);
      if (!this.refreshing) this.publishInventory(this.inventory);
    }
    if (!taskId || this.refreshing) return this.state;
    return this.loadSelectedTask(taskId);
  }

  dispose() {
    if (this.disposed) return;
    this.selectedTaskId = undefined;
    this.inventory = undefined;
    this.state = beginTopologyRefresh(this.state);
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = undefined;
    this.cancelSelectedTaskLoad();
    this.requestVersion += 1;
    this.listeners.clear();
  }

  private isCurrent(version: number) {
    return !this.disposed && version === this.requestVersion;
  }

  private async loadSelectedTask(taskId: string) {
    const inventory = this.inventory;
    if (
      !inventory
      || this.state.state !== 'ready'
      || this.selectedTaskId !== taskId
      || !topologyInventoryHasCurrentTask(inventory, taskId)
    ) return this.state;
    const abortController = new AbortController();
    const version = ++this.selectedVersion;
    this.selectedAbortController = abortController;
    const selected = await loadProjectTopologySelectedTask(
      this.source,
      inventory,
      taskId,
      { ...this.options, signal: abortController.signal }
    );
    if (
      this.disposed
      || version !== this.selectedVersion
      || this.selectedTaskId !== taskId
      || this.inventory !== inventory
    ) return this.state;
    this.inventory = selected;
    this.publishInventory(selected);
    this.scheduleAuthorityInvalidation(taskId);
    if (this.selectedAbortController === abortController) {
      this.selectedAbortController = undefined;
    }
    return this.state;
  }

  private cancelSelectedTaskLoad() {
    this.cancelAuthorityExpiry?.();
    this.cancelAuthorityExpiry = undefined;
    this.selectedAbortController?.abort();
    this.selectedAbortController = undefined;
    this.selectedVersion += 1;
  }

  private scheduleAuthorityInvalidation(taskId: string) {
    this.cancelAuthorityExpiry?.();
    this.cancelAuthorityExpiry = undefined;
    const authority = this.getSelectedTask(taskId)?.interaction.authority;
    if (!authority) return;
    const expiresAt = Date.parse(authority.expiresAt);
    const now = Date.parse(this.now());
    if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) {
      this.revokeSelectedAuthority(taskId);
      return;
    }
    const schedule = this.options.schedule ?? defaultSchedule;
    const expectedExpiry = authority.expiresAt;
    this.cancelAuthorityExpiry = schedule(() => {
      this.cancelAuthorityExpiry = undefined;
      const current = this.getSelectedTask(taskId)?.interaction.authority;
      if (current?.expiresAt === expectedExpiry) this.revokeSelectedAuthority(taskId);
    }, expiresAt - now);
  }

  private revokeSelectedAuthority(taskId: string) {
    if (this.selectedTaskId !== taskId || !this.inventory) return;
    this.inventory = withoutTopologyWriteCapabilities(this.inventory);
    this.publishInventory(this.inventory);
  }

  private now() {
    try {
      return this.options.clock?.() ?? new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  private update(state: ProjectTopologyReadState) {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A presentation subscriber cannot break evidence refresh ordering.
      }
    }
  }

  private publishInventory(inventory: ProjectTopologyInventory) {
    this.update(applyTopologyBuild(this.state, buildProjectTopology(inventory)));
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Portfolio refresh failed.';
}

function defaultSchedule(callback: () => void, delayMs: number) {
  const timer = globalThis.setTimeout(callback, Math.max(0, delayMs));
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => globalThis.clearTimeout(timer);
}
