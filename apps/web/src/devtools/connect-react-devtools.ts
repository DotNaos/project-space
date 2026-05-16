const reactDevToolsPort = 8097;

type ReactDevToolsHook = {
  sub?: unknown;
};

export async function connectReactDevTools() {
  if (!import.meta.env.DEV) {
    return;
  }

  const globalState = globalThis as typeof globalThis & {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevToolsHook;
    __projectSpaceReactDevToolsConnected__?: boolean;
  };

  if (globalState.__projectSpaceReactDevToolsConnected__) {
    return;
  }

  const { connectToDevTools, initialize } = await import('react-devtools-core');
  const existingHook = globalState.__REACT_DEVTOOLS_GLOBAL_HOOK__ as ReactDevToolsHook | undefined;

  // Vite's React refresh preamble installs a lightweight hook first.
  // React DevTools needs to replace it with the full evented hook.
  if (existingHook && typeof existingHook.sub !== 'function') {
    delete globalState.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  }

  initialize();
  globalState.__projectSpaceReactDevToolsConnected__ = true;

  connectToDevTools({
    host: 'localhost',
    isAppActive: () => document.visibilityState !== 'hidden',
    port: reactDevToolsPort
  });
}
