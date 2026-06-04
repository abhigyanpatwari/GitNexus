type DesktopShellState = {
  appName: string;
  isAlwaysOnTop: boolean;
  isMaximized: boolean;
  platform: string;
  titleBarHeight: number;
};

type DesktopApi = {
  appName: string;
  close: () => Promise<void>;
  getShellState: () => Promise<DesktopShellState>;
  minimize: () => Promise<DesktopShellState | null>;
  onWindowStateChanged: (callback: (state: DesktopShellState) => void) => () => void;
  platform: string;
  titleBarHeight: number;
  toggleAlwaysOnTop: () => Promise<DesktopShellState | null>;
  toggleMaximize: () => Promise<DesktopShellState | null>;
};

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Renderer root element was not found.');
}

const defaultDesktopState: DesktopShellState = {
  appName: 'GitNexus Desktop',
  isAlwaysOnTop: false,
  isMaximized: false,
  platform: 'win32',
  titleBarHeight: 38,
};

const fallbackDesktopApi: DesktopApi = {
  appName: defaultDesktopState.appName,
  close: async () => {},
  getShellState: async () => defaultDesktopState,
  minimize: async () => defaultDesktopState,
  onWindowStateChanged: () => () => {},
  platform: defaultDesktopState.platform,
  titleBarHeight: defaultDesktopState.titleBarHeight,
  toggleAlwaysOnTop: async () => defaultDesktopState,
  toggleMaximize: async () => defaultDesktopState,
};

const desktopApi =
  (window as Window & { gitnexusDesktop?: DesktopApi }).gitnexusDesktop ?? fallbackDesktopApi;

const shellState: DesktopShellState = {
  ...defaultDesktopState,
  appName: desktopApi.appName,
  platform: desktopApi.platform,
  titleBarHeight: desktopApi.titleBarHeight,
};

const styles = `
  :root {
    color-scheme: dark;
  }

  html,
  body,
  #root {
    width: 100%;
    height: 100%;
    margin: 0;
    overflow: hidden;
    background: #0d0d0d;
    color: #f4f4f5;
  }

  body {
    font-family: 'Segoe UI Variable', 'Segoe UI', 'SF Pro Text', system-ui, sans-serif;
  }

  .desktop-shell {
    --titlebar-height: 38px;
    height: 100%;
    display: grid;
    grid-template-rows: var(--titlebar-height) 1fr;
    background: #0d0d0d;
    overflow: hidden;
  }

  .desktop-shell--native-frame {
    grid-template-rows: 1fr;
  }

  .desktop-shell--native-frame .desktop-shell__titlebar {
    display: none;
  }

  .desktop-shell__titlebar {
    display: grid;
    grid-template-columns: minmax(144px, 1fr) auto minmax(144px, 1fr);
    align-items: center;
    gap: 12px;
    height: var(--titlebar-height);
    padding: 0 10px;
    box-sizing: border-box;
    background: #0d0d0d;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    -webkit-app-region: drag;
    user-select: none;
  }

  .desktop-shell__side {
    display: flex;
    align-items: center;
    min-width: 144px;
    min-height: 100%;
  }

  .desktop-shell__side--end {
    justify-content: flex-end;
  }

  .desktop-shell__title {
    justify-self: center;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: rgba(244, 244, 245, 0.92);
    white-space: nowrap;
  }

  .desktop-shell__spacer {
    min-width: 118px;
    min-height: 1px;
  }

  .desktop-shell__content {
    background: #0d0d0d;
  }

  @media (max-width: 720px) {
    .desktop-shell__titlebar {
      grid-template-columns: minmax(116px, 1fr) auto minmax(116px, 1fr);
      gap: 8px;
      padding: 0 8px;
    }

    .desktop-shell__side {
      min-width: 116px;
    }
  }
`;

const styleElement = document.createElement('style');
styleElement.textContent = styles;
document.head.append(styleElement);

const shell = document.createElement('div');
shell.className = 'desktop-shell';

const titlebar = document.createElement('header');
titlebar.className = 'desktop-shell__titlebar';

const leadingSide = document.createElement('div');
leadingSide.className = 'desktop-shell__side';

const titleElement = document.createElement('div');
titleElement.className = 'desktop-shell__title';

const trailingSide = document.createElement('div');
trailingSide.className = 'desktop-shell__side desktop-shell__side--end';

const content = document.createElement('main');
content.className = 'desktop-shell__content';
content.setAttribute('aria-hidden', 'true');

const spacer = (): HTMLDivElement => {
  const element = document.createElement('div');
  element.className = 'desktop-shell__spacer';
  element.setAttribute('aria-hidden', 'true');
  return element;
};

leadingSide.append(spacer());
trailingSide.append(spacer());

titlebar.append(leadingSide, titleElement, trailingSide);
shell.append(titlebar, content);
rootElement.replaceChildren(shell);

const applyShellState = (state: DesktopShellState): void => {
  shellState.appName = state.appName;
  shellState.isAlwaysOnTop = state.isAlwaysOnTop;
  shellState.isMaximized = state.isMaximized;
  shellState.platform = state.platform;
  shellState.titleBarHeight = state.titleBarHeight;

  shell.style.setProperty('--titlebar-height', `${state.titleBarHeight}px`);
  shell.classList.toggle('desktop-shell--native-frame', state.titleBarHeight === 0);
  titleElement.textContent = state.appName;
};

applyShellState(shellState);

void desktopApi.getShellState().then((state) => {
  applyShellState(state);
});

desktopApi.onWindowStateChanged((state) => {
  applyShellState(state);
});
