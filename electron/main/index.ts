import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAppShellHandlers } from './ipc/register-app-shell-handlers';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const enableReactDevTools = false;
const enableAgentBrowserDebugPort = Boolean(process.env.VITE_DEV_SERVER_URL);
let reactDevToolsWindow: BrowserWindow | null = null;

function getAppIconPath() {
  const runtimeIconPath = join(
    app.getAppPath(),
    `build/runtime-icons/${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}.png`
  );

  return runtimeIconPath;
}

function applyAppIcon() {
  const appIcon = nativeImage.createFromPath(getAppIconPath());

  if (appIcon.isEmpty()) {
    return;
  }

  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(appIcon);
  }
}

if (enableReactDevTools && process.env.VITE_DEV_SERVER_URL) {
  // Keep the app renderer responsive while the standalone React DevTools window is focused.
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
}

if (enableAgentBrowserDebugPort) {
  app.commandLine.appendSwitch('remote-debugging-port', '9223');
}

function createMainWindow() {
  const browserWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: '#111111',
    icon: getAppIconPath(),
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: {
      height: 42
    },
    webPreferences: {
      backgroundThrottling: !enableReactDevTools,
      preload: join(currentDirectory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  browserWindow.webContents.on('input-event', (_event, inputEvent) => {
    if (inputEvent.type === 'gestureScrollBegin') {
      browserWindow.webContents.send('gesture:scroll-state', 'begin');
    }

    if (inputEvent.type === 'gestureScrollEnd') {
      browserWindow.webContents.send('gesture:scroll-state', 'end');
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    browserWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    return browserWindow;
  }

  browserWindow.loadFile(join(currentDirectory, '../../dist/renderer/index.html'));
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
    backgroundColor: '#141414',
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

  applyAppIcon();
  nativeTheme.on('updated', applyAppIcon);

  registerAppShellHandlers();
  createMainWindow();

  if (enableReactDevTools && process.env.VITE_DEV_SERVER_URL) {
    createReactDevToolsWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();

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
