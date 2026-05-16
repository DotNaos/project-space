import { app, BrowserWindow, dialog } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalProjectSpaceBackend } from '../../server/local-project-space-backend';
import { createProjectSpaceServer } from '../../server/project-space-http';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const enableReactDevTools = false;
const enableAgentBrowserDebugPort = Boolean(process.env.VITE_DEV_SERVER_URL);
let reactDevToolsWindow: BrowserWindow | null = null;
let localBackend:
  | Awaited<ReturnType<typeof createProjectSpaceServer>>
  | undefined;

if (enableReactDevTools && process.env.VITE_DEV_SERVER_URL) {
  // Keep the app renderer responsive while the standalone React DevTools window is focused.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

if (enableAgentBrowserDebugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223');
}

function appendApiBaseUrl(frontendUrl: string, apiOrigin: string) {
  const url = new URL(frontendUrl);

  url.searchParams.set('projectSpaceApi', apiOrigin);

  return url.toString();
}

function createElectronBackend() {
  return createLocalProjectSpaceBackend({
    getAppMeta() {
      return {
        name: app.getName(),
        platform: process.platform,
        version: app.getVersion()
      };
    },
    async selectProjectDirectory() {
      const result = await dialog.showOpenDialog({
        title: 'Select project folder',
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      const selectedPath = result.filePaths[0];

      return {
        canceled: false,
        name: selectedPath.split('/').filter(Boolean).pop() ?? selectedPath,
        path: selectedPath
      };
    }
  });
}

async function createMainWindow() {
  const browserWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: '#07111e',
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: {
      height: 42
    },
    webPreferences: {
      backgroundThrottling: !enableReactDevTools,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    browserWindow.loadURL(
      appendApiBaseUrl(process.env.VITE_DEV_SERVER_URL, localBackend?.origin ?? '')
    );
    return browserWindow;
  }

  browserWindow.loadURL(localBackend?.origin ?? 'about:blank');
  return browserWindow;
}

function createReactDevToolsWindow() {
  if (reactDevToolsWindow && !reactDevToolsWindow.isDestroyed()) {
    reactDevToolsWindow.focus();
    return reactDevToolsWindow;
  }

  reactDevToolsWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f172a',
    title: 'React DevTools',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true
    }
  });

  reactDevToolsWindow.on('closed', () => {
    reactDevToolsWindow = null;
  });

  reactDevToolsWindow.loadFile(join(app.getAppPath(), 'electron/devtools/index.html'));
  return reactDevToolsWindow;
}

app.whenReady().then(async () => {
  if (enableReactDevTools && process.env.VITE_DEV_SERVER_URL) {
    process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  }

  localBackend = await createProjectSpaceServer({
    backend: createElectronBackend(),
    staticRoot: join(currentDirectory, '../../dist/renderer')
  });
  await createMainWindow();

  if (enableReactDevTools && process.env.VITE_DEV_SERVER_URL) {
    createReactDevToolsWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();

      if (enableReactDevTools && process.env.VITE_DEV_SERVER_URL) {
        createReactDevToolsWindow();
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  void localBackend?.close();
});
