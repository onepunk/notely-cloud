# Contributing to notely-cloud

Thanks for your interest in contributing. This repo is the cloud desktop client for Notely: an Electron app that syncs with the Notely platform backend.

## Development setup

1. Install prerequisites:
   - Node.js 20+
   - A C++ toolchain (for native addon builds)

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build main/renderer/preload:
   ```bash
   npm run build
   ```

4. Start the development app:
   ```bash
   npm run dev
   ```

## Running tests

The Playwright E2E suite requires a valid Notely platform backend and a test account. Set these environment variables before running sync/UI tests:

```bash
export TEST_EMAIL=<test-account-email>
export TEST_PASSWORD=<test-account-password>
export TEST_USER_ID=<test-user-uuid>
export SYNC_API_URL=https://api.yourdomain.com  # or your own backend
```

Tests that need these values will fail at load time if they're not set — there are no baked-in fallbacks.

Run the unit tests:

```bash
npm test
```

Run the E2E suite (requires a built app):

```bash
npm run test:e2e
```

On Linux, set `DEBUG_DB=true` to bypass the OS keystore. Do NOT set this in production builds.

## Building releases

This repo does not ship a production release pipeline. The original maintainer builds signed releases via an internal GitHub Actions workflow that uses DigiCert (Windows) and Apple (macOS) code-signing credentials held outside this repo. If you want to produce your own signed builds, you will need to configure your own signing credentials in a fork and add a workflow under `.github/workflows/`.

The included `.github/workflows/ci.yml` runs lint, type-check, and unit tests only.

## Pull request checklist

- [ ] `npm run type-check` passes
- [ ] `npm run lint` passes
- [ ] Tests updated where applicable
- [ ] No credentials, private keys, or personal identifiers committed
- [ ] Commit messages follow the conventional format (`type: subject`)

## Reporting security issues

See [`SECURITY.md`](./SECURITY.md). Do not file security reports as public issues.
