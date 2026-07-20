# Electron Desktop Build

Migration Guard can be packaged as a standalone Electron desktop app. The
desktop shell starts the existing local UI server and loads it in a locked-down
Electron window.

## Commands

```sh
npm run desktop:dev
npm run desktop:smoke
npm run desktop:pack
npm run desktop:dist
```

- `desktop:dev` builds TypeScript and launches the desktop app.
- `desktop:smoke` starts Electron in smoke mode, verifies `/api/session`, and
  exits without opening a window.
- `desktop:pack` writes an unpacked app under `release/`.
- `desktop:dist` writes a Windows NSIS installer under `release/`.

## Windows Output

```txt
release/Migration Guard Setup 0.3.0-beta.1.exe
release/win-unpacked/Migration Guard.exe
```

The app prefers a `.migration-guard.json` from the launch directory. If none is
found, it creates a desktop host config under Electron's `userData` directory so
first launch after installation still opens the UI.

## Current Limits

- The first desktop package uses Electron's default icon.
- The Windows installer is unsigned.
- macOS and Linux targets are configured, but only the Windows NSIS package has
  been exercised locally.
