import {
  loadProjectTopologyInventory,
  loadProjectTopologyTaskDetails,
  type ProjectTopologySource
} from './project-topology-loader';
import { buildProjectTopology } from './project-topology-model';
import { applyTopologyBuild, beginTopologyRefresh } from './project-topology-refresh';
import type { ProjectTopologyReadState } from './project-topology-types';

export interface ProjectTopologyControllerOptions {
  clock?: () => string;
  includeTranscripts?: boolean;
}

export class ProjectTopologyController {
  private abortController?: AbortController;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private requestVersion = 0;
  private state: ProjectTopologyReadState = { state: 'checking' };

  constructor(
    private readonly source: ProjectTopologySource,
    private readonly options: ProjectTopologyControllerOptions = {}
  ) {}

  getState = () => this.state;

  subscribe = (listener: () => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh() {
    if (this.disposed) return this.state;
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    const version = ++this.requestVersion;
    this.update(beginTopologyRefresh(this.state));
    try {
      const inventory = await loadProjectTopologyInventory(this.source, {
        ...this.options,
        includeTranscripts: false,
        signal: abortController.signal
      });
      if (!this.isCurrent(version)) return this.state;
      const baseBuild = buildProjectTopology(inventory);
      this.update(applyTopologyBuild(this.state, baseBuild));
      if (baseBuild.state === 'ready' && this.options.includeTranscripts !== false) {
        const detailed = await loadProjectTopologyTaskDetails(
          this.source,
          inventory,
          { ...this.options, signal: abortController.signal }
        );
        if (!this.isCurrent(version)) return this.state;
        this.update(applyTopologyBuild(this.state, buildProjectTopology(detailed)));
      }
    } catch (error) {
      if (!this.isCurrent(version)) return this.state;
      this.update(applyTopologyBuild(this.state, {
        reason: errorMessage(error),
        state: 'blocked'
      }, this.now()));
    }
    if (this.abortController === abortController) this.abortController = undefined;
    return this.state;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController?.abort();
    this.abortController = undefined;
    this.requestVersion += 1;
    this.listeners.clear();
  }

  private isCurrent(version: number) {
    return !this.disposed && version === this.requestVersion;
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
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : 'Topology refresh failed.';
}
