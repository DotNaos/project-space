import type { ProjectSpaceApi } from './shared/electron-api';

declare global {
  interface Window {
    projectSpace: ProjectSpaceApi;
  }
}

export {};
