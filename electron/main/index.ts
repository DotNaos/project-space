import { app, BrowserWindow } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAppShellHandlers } from './ipc/register-app-shell-handlers';

const currentDirectory = dirname(fileURLToPath(import.meta.url));

function createMainWindow() {
  const browserWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: '#07111e',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    browserWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    return browserWindow;
  }

  browserWindow.loadFile(join(currentDirectory, '../../dist/renderer/index.html'));
  return browserWindow;
}

app.whenReady().then(() => {
  registerAppShellHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
