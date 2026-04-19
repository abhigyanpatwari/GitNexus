import { useEffect, useState } from 'react';

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

const desktopApi = (window as Window & { gitnexusDesktop?: DesktopApi }).gitnexusDesktop ?? fallbackDesktopApi;

const styles = `
  :root {
    color-scheme: dark;
  }

  .desktop-shell {
    --titlebar-height: 38px;
    height: 100vh;
    display: grid;
    grid-template-rows: var(--titlebar-height) 1fr;
    background: #0d0d0d;
    color: #f4f4f5;
    overflow: hidden;
  }

  .desktop-shell__titlebar {
    display: grid;
    grid-template-columns: minmax(144px, 1fr) auto minmax(144px, 1fr);
    align-items: center;
    gap: 12px;
    height: var(--titlebar-height);
    padding: 0 10px;
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
    font-family: 'Segoe UI Variable', 'Segoe UI', 'SF Pro Text', system-ui, sans-serif;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: rgba(244, 244, 245, 0.9);
    white-space: nowrap;
  }

  .desktop-shell__spacer {
    min-width: 118px;
    min-height: 1px;
  }

  .desktop-shell__content {
    background: #0d0d0d;
  }

  .desktop-shell__content::after {
    content: '';
    display: block;
    width: 100%;
    height: 100%;
    background: #0d0d0d;
  }

  .window-controls,
  .traffic-lights {
    display: flex;
    align-items: center;
    gap: 0;
    -webkit-app-region: no-drag;
  }

  .window-control {
    width: 46px;
    height: calc(var(--titlebar-height) - 8px);
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: rgba(244, 244, 245, 0.88);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .window-control:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .window-control--close:hover {
    background: #c42b1c;
    color: #ffffff;
  }

  .window-control svg {
    width: 10px;
    height: 10px;
    stroke: currentColor;
    stroke-width: 1.2;
    fill: none;
    vector-effect: non-scaling-stroke;
  }

  .traffic-lights {
    gap: 8px;
  }

  .traffic-light {
    width: 12px;
    height: 12px;
    padding: 0;
    border: 0;
    border-radius: 999px;
    cursor: pointer;
    transition: filter 120ms ease, transform 120ms ease;
    -webkit-app-region: no-drag;
  }

  .traffic-light:hover {
    filter: brightness(1.04);
  }

  .traffic-light--close {
    background: #ff5f57;
  }

  .traffic-light--minimize {
    background: #febc2e;
  }

  .traffic-light--maximize {
    background: #28c840;
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

    .window-control {
      width: 42px;
    }
  }
`;

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 5h6" />
    </svg>
  );
}

function MaximizeIcon({ isMaximized }: { isMaximized: boolean }) {
  if (isMaximized) {
    return (
      <svg viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2.25 3.25h4.5v4.5h-4.5z" />
        <path d="M3.25 2.25h4.5v4.5" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2.25 2.25h5.5v5.5h-5.5z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true">
      <path d="M2 2l6 6" />
      <path d="M8 2L2 8" />
    </svg>
  );
}

export default function App() {
  const [shellState, setShellState] = useState<DesktopShellState>({
    ...defaultDesktopState,
    appName: desktopApi.appName,
    platform: desktopApi.platform,
    titleBarHeight: desktopApi.titleBarHeight,
  });

  useEffect(() => {
    let cancelled = false;

    void desktopApi.getShellState().then((state) => {
      if (!cancelled && state) {
        setShellState(state);
      }
    });

    const unsubscribe = desktopApi.onWindowStateChanged((state) => {
      if (!cancelled) {
        setShellState(state);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const isMac = shellState.platform === 'darwin';
  const handleMinimize = async (): Promise<void> => {
    const nextState = await desktopApi.minimize();

    if (nextState) {
      setShellState(nextState);
    }
  };

  const handleToggleMaximize = async (): Promise<void> => {
    const nextState = await desktopApi.toggleMaximize();

    if (nextState) {
      setShellState(nextState);
    }
  };

  const handleClose = async (): Promise<void> => {
    await desktopApi.close();
  };

  return (
    <>
      <style>{styles}</style>
      <div className="desktop-shell">
        <header className="desktop-shell__titlebar">
          <div className="desktop-shell__side">
            {isMac ? (
              <div className="traffic-lights" aria-label="Window controls">
                <button
                  type="button"
                  className="traffic-light traffic-light--close"
                  aria-label="Close window"
                  onClick={handleClose}
                />
                <button
                  type="button"
                  className="traffic-light traffic-light--minimize"
                  aria-label="Minimize window"
                  onClick={handleMinimize}
                />
                <button
                  type="button"
                  className="traffic-light traffic-light--maximize"
                  aria-label={shellState.isMaximized ? 'Restore window' : 'Maximize window'}
                  onClick={handleToggleMaximize}
                />
              </div>
            ) : (
              <div className="desktop-shell__spacer" aria-hidden="true" />
            )}
          </div>

          <div className="desktop-shell__title">{shellState.appName}</div>

          <div className="desktop-shell__side desktop-shell__side--end">
            {isMac ? (
              <div className="desktop-shell__spacer" aria-hidden="true" />
            ) : (
              <div className="window-controls" aria-label="Window controls">
                <button
                  type="button"
                  className="window-control"
                  aria-label="Minimize window"
                  onClick={handleMinimize}
                >
                  <MinimizeIcon />
                </button>
                <button
                  type="button"
                  className="window-control"
                  aria-label={shellState.isMaximized ? 'Restore window' : 'Maximize window'}
                  onClick={handleToggleMaximize}
                >
                  <MaximizeIcon isMaximized={shellState.isMaximized} />
                </button>
                <button
                  type="button"
                  className="window-control window-control--close"
                  aria-label="Close window"
                  onClick={handleClose}
                >
                  <CloseIcon />
                </button>
              </div>
            )}
          </div>
        </header>

        <main className="desktop-shell__content" aria-hidden="true" />
      </div>
    </>
  );
}