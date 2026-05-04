# Contributing

This project is a macOS Electron app that packages a pinned Hermes runtime. Treat code changes and release changes as separate risks: a green unit test run does not prove a customer install, and a packaged app launch does not prove every renderer or gateway edge case.

## Start Here

1. Read [Developer Onboarding](docs/DEVELOPER_ONBOARDING.md).
2. Read [Testing And Verification](docs/TESTING_AND_VERIFICATION.md).
3. Install dependencies:

```bash
npm install
```

4. Prove the checkout is healthy before editing:

```bash
npm run verify
```

`npm run verify` runs the default fast local gate: tests plus production build.

## Branches

- `gateway` is the active integration branch for current app and Hermes gateway work.
- `main` should stay aligned with `gateway` for the current repo shape.
- `deployment` is the GitHub Actions release branch. The mac bootstrap release workflow runs against this branch.

When preparing a release candidate, align all three branches to the same commit and run the release gates in [Testing And Verification](docs/TESTING_AND_VERIFICATION.md).

## Local Development

Use source dev mode for UI and main-process iteration:

```bash
npm run dev
```

Use the production preview after a build:

```bash
npm run build
npm start
```

Before starting a new dev session, clear stale local preview/dev processes if needed:

```bash
node scripts/ensure-clean-dev.js
```

Do not rely on your shell `PATH`, Homebrew Hermes, a local Jarvis checkout, or developer tools when judging release readiness. Packaged artifacts must use the bundled Hermes runtime under `agent-UI.app/Contents/Resources/hermes-runtime`.

## Change Checklist

For ordinary code changes:

```bash
npm test
npm run build
git diff --check
```

For dependency, security, packaging, Electron, IPC, or Hermes gateway changes, also run:

```bash
npm ls --depth=0
npm audit --json
```

For gateway/client behavior changes, run the relevant smoke tests:

```bash
npm run smoke:gateway
npm run smoke:installed-release -- /Applications/agent-UI.app
```

The installed-release smoke expects a built app already installed or extracted. It launches the app in eval mode with isolated config and Hermes state.

## Release Contributions

Release changes must keep these documents current:

- [Testing And Verification](docs/TESTING_AND_VERIFICATION.md)
- [Manual Customer Pass](docs/release/MANUAL_CUSTOMER_PASS.md)
- [Release Evidence Template](docs/release/evidence-template.md)

For a release candidate, do not stop at CI. Run the four rings:

1. Ring 0: local fast checks.
2. Ring 1: GitHub Actions build gate on `deployment`.
3. Ring 2: Tart clean-room VM gate for both DMG and zip.
4. Ring 3: manual Finder/Gatekeeper/TCC/customer workflow.

Bootstrap releases are ad-hoc signed and are not notarized. Finder right-click Open may be required on first launch. That is expected for the no-paid-Apple-Developer-plan path and must be recorded as release evidence.

## Provider Auth Boundary

The local desktop gateway secret is not the same as Hermes provider auth.

- agent-UI gateway config lives under `~/.agent-ui/`.
- Hermes provider credentials live in Hermes' own auth/config state.
- A reachable gateway can still return provider setup errors if Hermes has no provider configured.

Do not fix provider-auth failures by changing gateway transport code unless the logs show a gateway transport failure.

## Commit Hygiene

- Keep commits scoped to one behavior or documentation change.
- Do not commit secrets, local `.env` files, build output, downloaded artifacts, logs, or machine-specific state.
- Update tests when changing behavior.
- Update docs when changing setup, verification, packaging, release, or troubleshooting steps.
