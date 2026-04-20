import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const DESKTOP_APP_NAME = 'GitNexus Desktop';
const DESKTOP_GET_SHELL_STATE_CHANNEL = 'gitnexus-desktop:get-shell-state';
const DESKTOP_WINDOW_ACTION_CHANNEL = 'gitnexus-desktop:window-action';
const DESKTOP_WINDOW_STATE_CHANGED_CHANNEL = 'gitnexus-desktop:window-state-changed';
const DESKTOP_SHELL_TITLEBAR_HEIGHT = process.platform === 'darwin' ? 38 : 0;

type DesktopShellState = {
  appName: string;
  isAlwaysOnTop: boolean;
  isMaximized: boolean;
  platform: NodeJS.Platform;
  titleBarHeight: number;
};

type DesktopWindowAction = 'close' | 'minimize' | 'toggle-always-on-top' | 'toggle-maximize';

const invokeWindowAction = (action: DesktopWindowAction): Promise<DesktopShellState | null> => {
  return ipcRenderer.invoke(
    DESKTOP_WINDOW_ACTION_CHANNEL,
    action,
  ) as Promise<DesktopShellState | null>;
};

contextBridge.exposeInMainWorld('gitnexusDesktop', {
  appName: DESKTOP_APP_NAME,
  platform: process.platform,
  titleBarHeight: DESKTOP_SHELL_TITLEBAR_HEIGHT,
  close: async (): Promise<void> => {
    await invokeWindowAction('close');
  },
  getShellState: (): Promise<DesktopShellState> => {
    return ipcRenderer.invoke(DESKTOP_GET_SHELL_STATE_CHANNEL) as Promise<DesktopShellState>;
  },
  minimize: (): Promise<DesktopShellState | null> => {
    return invokeWindowAction('minimize');
  },
  onWindowStateChanged: (callback: (state: DesktopShellState) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: DesktopShellState): void => {
      callback(state);
    };

    ipcRenderer.on(DESKTOP_WINDOW_STATE_CHANGED_CHANNEL, listener);

    return () => {
      ipcRenderer.removeListener(DESKTOP_WINDOW_STATE_CHANGED_CHANNEL, listener);
    };
  },
  toggleAlwaysOnTop: (): Promise<DesktopShellState | null> => {
    return invokeWindowAction('toggle-always-on-top');
  },
  toggleMaximize: (): Promise<DesktopShellState | null> => {
    return invokeWindowAction('toggle-maximize');
  },
});
