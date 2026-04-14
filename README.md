# Notely Cloud

Cloud desktop client for the Notely platform. An Electron app that syncs notes, transcriptions, and AI summaries with a self-hosted [`notely-platform`](https://github.com/onepunk/notely-platform) backend.

## Prerequisites

- Node.js 20+
- A C++ toolchain (for native addons: `better-sqlite3`, `keytar`)
- Platform headers:
  - **Ubuntu/Debian**: `build-essential g++ make python3 python3-dev libsecret-1-dev`
  - **macOS**: Xcode command-line tools
  - **Windows**: Visual Studio Build Tools with the "Desktop development with C++" workload

## Development setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the dev app (Vite dev server + Electron):
   ```bash
   npm run dev
   ```

## Configuration

The app talks to a backend at the URL configured in settings. By default, newly installed instances prompt for a server URL on first run. If you are running your own [`notely-platform`](https://github.com/onepunk/notely-platform) deployment, point the client at that URL.

### Development-only environment variables

- `DEBUG_DB=true` — disables SQLCipher database encryption. Development only. Never set on production builds; the app logs a prominent warning at startup when it is active.
- `NOTELY_USER_DATA` — override the Electron `app.getPath('userData')` location (useful for running multiple instances side-by-side during development).

## Building a release

The public repo ships a minimal CI workflow (`.github/workflows/ci.yml`) that runs lint and type-check only. It does **not** build signed release artifacts.

If you want to produce signed builds of your own, set up a fork and add a workflow that configures the relevant signing credentials (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, etc.) as GitHub Actions secrets, and call `electron-builder`.

## Database encryption

The local SQLite database is encrypted with SQLCipher. The encryption key is stored in the OS-native keystore (macOS Keychain, Windows Credential Manager, Linux libsecret).

- **Export a recovery key**: invoke the IPC `security:exportRecoveryKey` to receive a 64-char hex key. Back it up securely.
- **Import a recovery key**: on a fresh install, invoke `security:importRecoveryKey` with the backed-up hex key before opening encrypted content.

See `docs/DATABASE_ENCRYPTION.md` for full details.

## Related repositories

- [`notely-platform`](https://github.com/onepunk/notely-platform) — backend microservices
- [`notely-ai`](https://github.com/onepunk/notely-ai) — standalone AI desktop client with local transcription/summarization

## Security

To report a vulnerability, see [`SECURITY.md`](./SECURITY.md).

## License

Apache License 2.0. See [`LICENSE`](./LICENSE).
