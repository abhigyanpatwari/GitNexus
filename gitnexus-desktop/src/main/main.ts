import { app, BrowserView, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getPackagedRendererEntry,
  getRequestedPath,
  normalizeStaticPath,
} from './runtime-paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DESKTOP_APP_NAME = 'GitNexus Desktop';
const DESKTOP_SHELL_TITLEBAR_HEIGHT = 38;
const DESKTOP_BACKGROUND_COLOR = '#0d0d0d';
const DESKTOP_APP_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  : path.resolve(
      __dirname,
      process.platform === 'win32' ? '../../build/icon.ico' : '../../build/icon.png',
    );
const DESKTOP_GET_SHELL_STATE_CHANNEL = 'gitnexus-desktop:get-shell-state';
const DESKTOP_WINDOW_ACTION_CHANNEL = 'gitnexus-desktop:window-action';
const DESKTOP_WINDOW_STATE_CHANGED_CHANNEL = 'gitnexus-desktop:window-state-changed';
const GITNEXUS_PORT = 4747;
const GITNEXUS_HOST = 'localhost';
const GITNEXUS_SERVER_URL = `http://${GITNEXUS_HOST}:${GITNEXUS_PORT}`;
const GITNEXUS_SERVER_HEALTH_URLS = [
  `${GITNEXUS_SERVER_URL}/api/info`,
  `http://127.0.0.1:${GITNEXUS_PORT}/api/info`,
  `http://[::1]:${GITNEXUS_PORT}/api/info`,
];
const GITNEXUS_DEV_RUNTIME_DIR = path.resolve(__dirname, '../../../gitnexus');
const GITNEXUS_WEB_DEV_HOST = 'localhost';
const GITNEXUS_WEB_DEV_PORT = 5173;
const GITNEXUS_WEB_DEV_URL = `http://${GITNEXUS_WEB_DEV_HOST}:${GITNEXUS_WEB_DEV_PORT}`;
const GITNEXUS_WEB_DEV_ROOT = path.resolve(__dirname, '../../gitnexus-web');
const GITNEXUS_WEB_DEV_ROOT_FALLBACK = path.resolve(__dirname, '../../../gitnexus-web');
const GITNEXUS_PACKAGED_RUNTIME_DIR = path.join(process.resourcesPath, 'gitnexus');
const GITNEXUS_WEB_PACKAGED_DIR = path.join(process.resourcesPath, 'gitnexus-web');
// On Windows, native modules (e.g. lbugjs.node) PE-import node.exe by name.
// Electron's binary is not node.exe, so LoadLibrary fails with an access violation.
// Bundling a real node.exe and using it as the subprocess host avoids the crash.
const GITNEXUS_PACKAGED_NODE_BINARY = path.join(process.resourcesPath, 'runtime', 'node.exe');
const GITNEXUS_WEB_EXPECTED_MARKERS = ['<title>GitNexus</title>', '<div id="root"></div>'];
const GITNEXUS_SERVER_READY_TIMEOUT_MS = 120_000;
const GITNEXUS_WEB_READY_TIMEOUT_MS = 60_000;
const GITNEXUS_WEB_READY_POLL_MS = 500;
const PACKAGED_WEB_SERVER_HOST = '127.0.0.1';
const IS_DESKTOP_SMOKE_TEST = process.env.GITNEXUS_DESKTOP_SMOKE_TEST === '1';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

let serverReadyPromise: Promise<void> | null = null;
let gitNexusServerProcess: ChildProcess | null = null;
let gitNexusServerOutput = '';
let webDevServerProcess: ChildProcess | null = null;
let webDevServerOutput = '';
let packagedWebServer: Server | null = null;
let packagedWebServerUrl: string | null = null;
const openWindows = new Set<BrowserWindow>();
const contentViews = new WeakMap<BrowserWindow, BrowserView>();

const getDesktopShellTitlebarHeight = (): number => {
  return process.platform === 'darwin' ? DESKTOP_SHELL_TITLEBAR_HEIGHT : 0;
};

type DesktopShellState = {
  appName: string;
  isAlwaysOnTop: boolean;
  isMaximized: boolean;
  platform: NodeJS.Platform;
  titleBarHeight: number;
};

type DesktopWindowAction = 'close' | 'minimize' | 'toggle-always-on-top' | 'toggle-maximize';

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const isAddressInUseError = (error: unknown): boolean => {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE';
};

const isAllowedExternalUrl = (value: string): boolean => {
  try {
    const url = new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
};

const openExternalUrlIfSafe = (value: string): void => {
  if (!isAllowedExternalUrl(value)) {
    return;
  }

  void shell.openExternal(value);
};

const getUrlOrigin = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const appendProcessOutput = (chunk: Buffer | string): void => {
  webDevServerOutput = `${webDevServerOutput}${chunk.toString()}`.slice(-8_192);
};

const appendGitNexusServerOutput = (chunk: Buffer | string): void => {
  gitNexusServerOutput = `${gitNexusServerOutput}${chunk.toString()}`.slice(-8_192);
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

const fetchUrlText = async (url: string, timeoutMs: number): Promise<string | null> => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      cache: 'no-store',
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutHandle);
  }
};

const isHttpUrlReady = async (url: string, expectedMarkers?: string[]): Promise<boolean> => {
  const responseText = await fetchUrlText(url, 2_000);

  if (!responseText) {
    return false;
  }

  if (!expectedMarkers || expectedMarkers.length === 0) {
    return true;
  }

  return expectedMarkers.every((marker) => responseText.includes(marker));
};

const isAnyHttpUrlReady = async (urls: string[], expectedMarkers?: string[]): Promise<boolean> => {
  for (const url of urls) {
    if (await isHttpUrlReady(url, expectedMarkers)) {
      return true;
    }
  }

  return false;
};

const waitForUrlReady = async (
  url: string,
  timeoutMs: number,
  expectedMarkers?: string[],
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isHttpUrlReady(url, expectedMarkers)) {
      return;
    }

    if (webDevServerProcess?.exitCode !== null && webDevServerProcess?.exitCode !== undefined) {
      const output = webDevServerOutput.trim();
      throw new Error(
        output
          ? `GitNexus web dev server exited before it became ready.\n\n${output}`
          : 'GitNexus web dev server exited before it became ready.',
      );
    }

    await sleep(GITNEXUS_WEB_READY_POLL_MS);
  }

  const output = webDevServerOutput.trim();
  throw new Error(
    output
      ? `Timed out waiting for GitNexus web dev server at ${url}.\n\n${output}`
      : `Timed out waiting for GitNexus web dev server at ${url}.`,
  );
};

const getGitNexusRuntimeDir = (): string => {
  return app.isPackaged ? GITNEXUS_PACKAGED_RUNTIME_DIR : GITNEXUS_DEV_RUNTIME_DIR;
};

const getGitNexusCliEntry = (): string => {
  return path.join(getGitNexusRuntimeDir(), 'dist', 'cli', 'index.js');
};

const getGitNexusWebDevRoot = (): string => {
  return existsSync(GITNEXUS_WEB_DEV_ROOT) ? GITNEXUS_WEB_DEV_ROOT : GITNEXUS_WEB_DEV_ROOT_FALLBACK;
};

const getGitNexusWebViteCliEntry = (): string => {
  return path.join(getGitNexusWebDevRoot(), 'node_modules', 'vite', 'bin', 'vite.js');
};

const getNodeCommand = (): string => {
  if (app.isPackaged) {
    if (process.platform === 'win32' && existsSync(GITNEXUS_PACKAGED_NODE_BINARY)) {
      return GITNEXUS_PACKAGED_NODE_BINARY;
    }

    return process.execPath;
  }

  return (
    process.env.npm_node_execpath ||
    process.env.NODE ||
    (process.platform === 'win32' ? 'node.exe' : 'node')
  );
};

const getNodeProcessEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const environment = {
    ...process.env,
    ...overrides,
  };

  if (app.isPackaged) {
    // Only set ELECTRON_RUN_AS_NODE when falling back to the Electron binary as the node host.
    // When using the bundled node.exe, the host is already a real node process — no flag needed.
    const usingBundledNode =
      process.platform === 'win32' && existsSync(GITNEXUS_PACKAGED_NODE_BINARY);

    if (!usingBundledNode) {
      environment.ELECTRON_RUN_AS_NODE = '1';
    }
  }

  return environment;
};

const spawnGitNexusServer = (): ChildProcess => {
  const childProcess = spawn(
    getNodeCommand(),
    [getGitNexusCliEntry(), 'serve', '--host', GITNEXUS_HOST],
    {
      cwd: getGitNexusRuntimeDir(),
      env: getNodeProcessEnvironment(app.isPackaged ? { GITNEXUS_DISABLE_MCP_HTTP: '1' } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  childProcess.stdout?.on('data', (chunk) => {
    appendGitNexusServerOutput(chunk);
    process.stdout.write(`[gitnexus-server] ${chunk.toString()}`);
  });

  childProcess.stderr?.on('data', (chunk) => {
    appendGitNexusServerOutput(chunk);
    process.stderr.write(`[gitnexus-server] ${chunk.toString()}`);
  });

  childProcess.once('error', (error) => {
    appendGitNexusServerOutput(getErrorMessage(error));
  });

  childProcess.once('exit', () => {
    serverReadyPromise = null;
  });

  return childProcess;
};

const waitForGitNexusServerReady = async (): Promise<void> => {
  const deadline = Date.now() + GITNEXUS_SERVER_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isAnyHttpUrlReady(GITNEXUS_SERVER_HEALTH_URLS)) {
      return;
    }

    if (gitNexusServerProcess?.exitCode !== null && gitNexusServerProcess?.exitCode !== undefined) {
      const output = gitNexusServerOutput.trim();
      throw new Error(
        output
          ? `GitNexus backend exited before it became ready.\n\n${output}`
          : 'GitNexus backend exited before it became ready.',
      );
    }

    await sleep(GITNEXUS_WEB_READY_POLL_MS);
  }

  const output = gitNexusServerOutput.trim();
  throw new Error(
    output
      ? `Timed out waiting for GitNexus backend at ${GITNEXUS_SERVER_HEALTH_URLS.join(', ')}.\n\n${output}`
      : `Timed out waiting for GitNexus backend at ${GITNEXUS_SERVER_HEALTH_URLS.join(', ')}.`,
  );
};

const spawnWebDevServer = (): ChildProcess => {
  const childProcess = spawn(
    getNodeCommand(),
    [
      getGitNexusWebViteCliEntry(),
      '--host',
      GITNEXUS_WEB_DEV_HOST,
      '--port',
      String(GITNEXUS_WEB_DEV_PORT),
      '--strictPort',
    ],
    {
      cwd: getGitNexusWebDevRoot(),
      env: getNodeProcessEnvironment({ BROWSER: 'none' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );

  childProcess.stdout?.on('data', (chunk) => {
    appendProcessOutput(chunk);
    process.stdout.write(`[gitnexus-web] ${chunk.toString()}`);
  });

  childProcess.stderr?.on('data', (chunk) => {
    appendProcessOutput(chunk);
    process.stderr.write(`[gitnexus-web] ${chunk.toString()}`);
  });

  childProcess.once('error', (error) => {
    appendProcessOutput(getErrorMessage(error));
  });

  return childProcess;
};

const ensureWebDevServerStarted = async (): Promise<void> => {
  if (await isHttpUrlReady(GITNEXUS_WEB_DEV_URL, GITNEXUS_WEB_EXPECTED_MARKERS)) {
    return;
  }

  if (!webDevServerProcess || webDevServerProcess.exitCode !== null) {
    webDevServerOutput = '';
    webDevServerProcess = spawnWebDevServer();
  }

  await waitForUrlReady(
    GITNEXUS_WEB_DEV_URL,
    GITNEXUS_WEB_READY_TIMEOUT_MS,
    GITNEXUS_WEB_EXPECTED_MARKERS,
  );
};

export const sendStaticResponse = (assetPath: string | null, response: ServerResponse): void => {
  if (!assetPath) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  try {
    if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const contentType = MIME_TYPES[path.extname(assetPath)] ?? 'application/octet-stream';
  const stream = createReadStream(assetPath);

  stream.once('error', () => {
    if (!response.headersSent) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal server error');
      return;
    }

    response.destroy();
  });

  response.once('close', () => {
    if (!stream.destroyed) {
      stream.destroy();
    }
  });

  stream.once('open', () => {
    if (response.destroyed) {
      stream.destroy();
      return;
    }

    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
    });
    stream.pipe(response);
  });
};

const handlePackagedWebRequest = (request: IncomingMessage, response: ServerResponse): void => {
  const requestUrl = request.url ?? '/';
  const requestedPath = getRequestedPath(requestUrl);

  if (!requestedPath) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  sendStaticResponse(normalizeStaticPath(GITNEXUS_WEB_PACKAGED_DIR, requestedPath), response);
};

const ensurePackagedWebServerStarted = async (): Promise<string> => {
  if (packagedWebServerUrl) {
    return packagedWebServerUrl;
  }

  const packagedIndex = path.join(GITNEXUS_WEB_PACKAGED_DIR, 'index.html');

  if (!existsSync(packagedIndex)) {
    throw new Error(
      `GitNexus web bundle was not found at ${packagedIndex}. Run the desktop packaging flow to stage gitnexus-web/dist.`,
    );
  }

  packagedWebServer = createServer(handlePackagedWebRequest);

  await new Promise<void>((resolve, reject) => {
    packagedWebServer?.once('error', reject);
    packagedWebServer?.listen(0, PACKAGED_WEB_SERVER_HOST, () => {
      resolve();
    });
  });

  const address = packagedWebServer.address();

  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve the packaged GitNexus web server address.');
  }

  packagedWebServerUrl = `http://${PACKAGED_WEB_SERVER_HOST}:${address.port}`;
  return packagedWebServerUrl;
};

const stopWebDevServer = (): void => {
  if (!webDevServerProcess || !webDevServerProcess.pid || webDevServerProcess.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(webDevServerProcess.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    webDevServerProcess.kill('SIGTERM');
  }

  webDevServerProcess = null;
};

const stopGitNexusServer = (): void => {
  if (
    !gitNexusServerProcess ||
    !gitNexusServerProcess.pid ||
    gitNexusServerProcess.exitCode !== null
  ) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(gitNexusServerProcess.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    gitNexusServerProcess.kill('SIGTERM');
  }

  gitNexusServerProcess = null;
};

const stopPackagedWebServer = (): void => {
  if (!packagedWebServer) {
    return;
  }

  packagedWebServer.close();
  packagedWebServer = null;
  packagedWebServerUrl = null;
};

const exitStartupFailure = (): void => {
  stopGitNexusServer();
  stopPackagedWebServer();
  stopWebDevServer();
  process.exit(1);
};

const getDesktopShellState = (window: BrowserWindow): DesktopShellState => {
  return {
    appName: DESKTOP_APP_NAME,
    isAlwaysOnTop: window.isAlwaysOnTop(),
    isMaximized: window.isMaximized() || window.isFullScreen(),
    platform: process.platform,
    titleBarHeight: getDesktopShellTitlebarHeight(),
  };
};

const emitDesktopShellState = (window: BrowserWindow): void => {
  if (window.isDestroyed()) {
    return;
  }

  window.webContents.send(DESKTOP_WINDOW_STATE_CHANGED_CHANNEL, getDesktopShellState(window));
};

const getWindowFromSender = (sender: Electron.WebContents): BrowserWindow => {
  const window = BrowserWindow.fromWebContents(sender);

  if (!window) {
    throw new Error('Unable to resolve the active desktop window.');
  }

  return window;
};

const updateContentViewBounds = (window: BrowserWindow): void => {
  const contentView = contentViews.get(window);

  if (!contentView) {
    return;
  }

  const [width, height] = window.getContentSize();
  const titlebarHeight = getDesktopShellTitlebarHeight();

  contentView.setBounds({
    x: 0,
    y: titlebarHeight,
    width: Math.max(width, 1),
    height: Math.max(height - titlebarHeight, 1),
  });
};

const createEmbeddedContentView = (contentUrl: string): BrowserView => {
  // BrowserView is deprecated in Electron; keep this isolated until we migrate to WebContentsView.
  const contentView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const allowedOrigin = getUrlOrigin(contentUrl);

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    if (!allowedOrigin || getUrlOrigin(url) !== allowedOrigin) {
      openExternalUrlIfSafe(url);
    }

    return { action: 'deny' };
  });

  contentView.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!allowedOrigin || getUrlOrigin(navigationUrl) === allowedOrigin) {
      return;
    }

    event.preventDefault();
    openExternalUrlIfSafe(navigationUrl);
  });

  return contentView;
};

const loadShellRenderer = async (window: BrowserWindow): Promise<void> => {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;

  if (rendererUrl) {
    console.info(`[gitnexus-desktop] Loading shell renderer: ${rendererUrl}`);
    await window.loadURL(rendererUrl);
    return;
  }

  const rendererEntry = getPackagedRendererEntry(__dirname);
  console.info(`[gitnexus-desktop] Loading shell renderer file: ${rendererEntry}`);
  await window.loadFile(rendererEntry);
};

const registerWindowIpcHandlers = (): void => {
  ipcMain.removeHandler(DESKTOP_GET_SHELL_STATE_CHANNEL);
  ipcMain.removeHandler(DESKTOP_WINDOW_ACTION_CHANNEL);

  ipcMain.handle(DESKTOP_GET_SHELL_STATE_CHANNEL, (event) => {
    const window = getWindowFromSender(event.sender);

    return getDesktopShellState(window);
  });

  ipcMain.handle(DESKTOP_WINDOW_ACTION_CHANNEL, (event, action: DesktopWindowAction) => {
    const window = getWindowFromSender(event.sender);

    switch (action) {
      case 'close':
        window.close();
        return null;
      case 'minimize':
        window.minimize();
        return getDesktopShellState(window);
      case 'toggle-always-on-top':
        window.setAlwaysOnTop(!window.isAlwaysOnTop());
        return getDesktopShellState(window);
      case 'toggle-maximize':
        if (window.isMaximized()) {
          window.unmaximize();
        } else {
          window.maximize();
        }

        return getDesktopShellState(window);
      default:
        throw new Error(`Unsupported desktop window action: ${String(action)}`);
    }
  });
};

const showStartupError = (error: unknown): void => {
  console.error('[gitnexus-desktop] Startup failed.', error);

  // In CI smoke tests, dialog.showErrorBox() blocks synchronously forever (no display).
  // Log the error above and let process.exit() handle the failure signal instead.
  if (IS_DESKTOP_SMOKE_TEST) {
    return;
  }

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

const ensureGitNexusServerStarted = async (): Promise<void> => {
  if (!serverReadyPromise) {
    serverReadyPromise = (async () => {
      if (await isAnyHttpUrlReady(GITNEXUS_SERVER_HEALTH_URLS)) {
        return;
      }

      if (!gitNexusServerProcess || gitNexusServerProcess.exitCode !== null) {
        gitNexusServerOutput = '';
        gitNexusServerProcess = spawnGitNexusServer();
      }

      await waitForGitNexusServerReady();
    })().catch((error) => {
      serverReadyPromise = null;
      throw error;
    });
  }

  await serverReadyPromise;
};

async function createWindow(): Promise<void> {
  let embeddedAppUrl: string;

  if (app.isPackaged) {
    embeddedAppUrl = await ensurePackagedWebServerStarted();
  } else {
    await ensureWebDevServerStarted();
    embeddedAppUrl = GITNEXUS_WEB_DEV_URL;
  }

  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: DESKTOP_APP_NAME,
    icon: DESKTOP_APP_ICON_PATH,
    backgroundColor: DESKTOP_BACKGROUND_COLOR,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contentView = createEmbeddedContentView(embeddedAppUrl);

  window.setMenuBarVisibility(false);
  window.setBrowserView(contentView);
  contentViews.set(window, contentView);
  updateContentViewBounds(window);

  openWindows.add(window);

  window.on('resize', () => {
    updateContentViewBounds(window);
  });

  window.on('maximize', () => {
    emitDesktopShellState(window);
  });

  window.on('unmaximize', () => {
    emitDesktopShellState(window);
  });

  window.on('enter-full-screen', () => {
    emitDesktopShellState(window);
  });

  window.on('leave-full-screen', () => {
    emitDesktopShellState(window);
  });

  window.on('always-on-top-changed', () => {
    emitDesktopShellState(window);
  });

  window.once('closed', () => {
    openWindows.delete(window);
    contentViews.delete(window);
  });

  console.info(`[gitnexus-desktop] Loading embedded app URL: ${embeddedAppUrl}`);
  await Promise.all([loadShellRenderer(window), contentView.webContents.loadURL(embeddedAppUrl)]);
  emitDesktopShellState(window);

  if (!window.isDestroyed()) {
    window.show();

    if (IS_DESKTOP_SMOKE_TEST) {
      setTimeout(() => {
        app.quit();
      }, 1_000);
    }
  }
}

app.whenReady().then(async () => {
  try {
    registerWindowIpcHandlers();
    await ensureGitNexusServerStarted();
    await createWindow();
  } catch (error) {
    showStartupError(error);
    exitStartupFailure();
  }

  app.on('activate', () => {
    if (openWindows.size === 0) {
      void ensureGitNexusServerStarted()
        .then(() => createWindow())
        .catch((error) => {
          showStartupError(error);
          exitStartupFailure();
        });
    }
  });
});

app.on('before-quit', () => {
  stopGitNexusServer();
  stopPackagedWebServer();
  stopWebDevServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
