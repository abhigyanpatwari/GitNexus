# GitNexus Desktop

Electron desktop shell for GitNexus. The app starts the local backend and loads the real `gitnexus-web` UI inside the desktop window.

## Commands

```bash
npm run dev
npm run build:dir
npm run build:win
npm run build:mac
npm run build:linux
```

- `npm run dev` starts the Electron shell plus the local GitNexus backend.
- `npm run build:dir` creates an unpacked desktop app directory.
- `npm run build:win` creates a Windows NSIS installer `.exe`.
- `npm run build:mac` creates a macOS `.dmg`.
- `npm run build:linux` creates a Linux `.AppImage`.
- `npm run smoke:unpacked` launches the latest unpacked desktop build, verifies startup, and exits.

Build output is written under `gitnexus-desktop/release/<timestamp>/`.

## PR Artifacts

The `Desktop Packaging` GitHub Actions workflow builds an unpacked desktop app, smoke-tests startup, then uploads preview desktop artifacts for pull requests that touch `.github/workflows/desktop-packaging.yml`, `gitnexus-desktop/**`, `gitnexus/**`, `gitnexus-web/**`, or `gitnexus-shared/**`.

- `gitnexus-desktop-windows` contains the Windows NSIS installer `.exe` and `win-unpacked/`.
- `gitnexus-desktop-macos` contains the macOS `.dmg` and `mac*/` output.
- `gitnexus-desktop-linux` contains the Linux `.AppImage` and `linux-unpacked/`.

GitHub artifact URLs are run-specific and expire, so use the artifact names above from the latest successful PR workflow run.
