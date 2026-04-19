import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GITNEXUS_PORT = 4747;
const GITNEXUS_HOST = 'localhost';
const GITNEXUS_SERVER_ENTRY = path.resolve(__dirname, '../../../gitnexus/dist/server/api.js');

type GitNexusServerModule = {
  createServer: (port: number, host?: string) => Promise<void>;
};

let serverReadyPromise: Promise<void> | null = null;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const isAddressInUseError = (error: unknown): boolean => {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
};

const showStartupError = (error: unknown): void => {
  if (isAddressInUseError(error)) {
    dialog.showErrorBox(
      'GitNexus Desktop Startup Failed',
      `Port ${GITNEXUS_PORT} is already in use.\n\nStop the other process using port ${GITNEXUS_PORT} and try again.`,
    );
    return;
  }

  dialog.showErrorBox(
    'GitNexus Desktop Startup Failed',
    `Failed to start GitNexus Desktop.\n\n${getErrorMessage(error)}`,
  );
};

const loadGitNexusServerModule = async (): Promise<GitNexusServerModule> => {
  try {
    return (await import(pathToFileURL(GITNEXUS_SERVER_ENTRY).href)) as GitNexusServerModule;
  } catch (error) {
    throw new Error(
      `Could not load the GitNexus server runtime at ${GITNEXUS_SERVER_ENTRY}. ${getErrorMessage(error)}`,
    );
  }
};

const ensureGitNexusServerStarted = async (): Promise<void> => {
  if (!serverReadyPromise) {
    serverReadyPromise = (async () => {
      const { createServer } = await loadGitNexusServerModule();
      await createServer(GITNEXUS_PORT, GITNEXUS_HOST);
    })().catch((error) => {
      serverReadyPromise = null;
      throw error;
    });
  }

  await serverReadyPromise;
};

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'GitNexus Desktop',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, '../renderer/src/renderer/index.html'));
}

app.whenReady().then(async () => {
  try {
    await ensureGitNexusServerStarted();
    await createWindow();
  } catch (error) {
    showStartupError(error);
    app.quit();
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((error) => {
        showStartupError(error);
        app.quit();
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});