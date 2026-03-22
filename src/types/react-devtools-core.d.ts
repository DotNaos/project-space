declare module 'react-devtools-core' {
  export function initialize(
    settings?: unknown,
    shouldStartProfilingNow?: boolean,
    profilingSettings?: unknown
  ): void;

  export function connectToDevTools(options?: {
    host?: string;
    isAppActive?: () => boolean;
    port?: number;
    retryConnectionDelay?: number;
    useHttps?: boolean;
    websocket?: unknown;
    onSettingsUpdated?: (settings: unknown) => void;
  }): void;
}
