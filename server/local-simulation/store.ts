import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createLocalSimulationSeed } from './seed';
import { isLocalSimulationState, type LocalSimulationState } from './state';

export class LocalSimulationStore {
  private queue = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly rootPath: string
  ) {}

  async read() {
    await this.queue;
    return this.readOrCreate();
  }

  update<T>(mutate: (state: LocalSimulationState) => T | Promise<T>) {
    const operation = this.queue.then(async () => {
      const state = await this.readOrCreate();
      const result = await mutate(state);
      state.revision += 1;
      state.updatedAt = new Date().toISOString();
      await this.write(state);
      return result;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async reset() {
    await this.update((state) => {
      const seed = createLocalSimulationSeed(this.rootPath);
      const revision = state.revision;
      for (const key of Object.keys(state) as Array<keyof LocalSimulationState>) {
        delete state[key];
      }
      Object.assign(state, seed, { revision });
    });
    return this.read();
  }

  private async readOrCreate() {
    let body: string;
    try {
      body = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const seed = createLocalSimulationSeed(this.rootPath);
      await this.write(seed);
      return seed;
    }
    const state: unknown = JSON.parse(body);
    if (!isLocalSimulationState(state)) {
      throw new Error('The Project-managed local simulation state is invalid.');
    }
    return state;
  }

  private async write(state: LocalSimulationState) {
    const directory = dirname(this.path);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
