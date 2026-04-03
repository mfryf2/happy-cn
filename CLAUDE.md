# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Package-Level Guidance

Each package has its own `CLAUDE.md` with detailed guidelines:
- `packages/happy-app/CLAUDE.md` — React Native/Expo mobile+web client
- `packages/happy-server/CLAUDE.md` — Fastify backend server
- `packages/happy-cli/CLAUDE.md` — CLI wrapper for Claude Code/Codex

## Root Commands

```bash
yarn cli                      # Run the CLI (delegates to happy-cli workspace)
yarn web                      # Run the web app (delegates to happy-app workspace)
yarn app-logs                 # Start the log aggregator server
yarn release                  # Run the release script
```

### Environment Management

The repo has a custom multi-environment system in `environments/`. Commands run from the repo root:

```bash
yarn env:list                 # List all environments
yarn env:current              # Show active environment
yarn env:new                  # Create a new environment
yarn env:use                  # Switch environments
yarn env:up                   # Start environment services (Docker)
yarn env:down                 # Stop environment services
yarn env:seed                 # Seed environment with test data
yarn env:server / env:web / env:ios / env:android / env:cli   # Run component in current env
```

For local development without Docker, use `yarn standalone:dev` inside `packages/happy-server`.

## Architecture Overview

**Happy Coder** is a multi-platform AI coding agent controller. It lets users remotely control Claude Code or Codex sessions running on their computer from a phone, tablet, or web browser, with end-to-end encryption.

### System Components

```
packages/happy-wire     # Shared TypeScript types and Zod schemas — the protocol layer
packages/happy-cli      # CLI wrapper that runs on the developer's computer alongside Claude Code
packages/happy-server   # Central backend (Fastify + PostgreSQL/PGlite + Socket.io)
packages/happy-app      # Multi-platform client (React Native, Expo, Tauri for macOS)
packages/happy-agent    # Standalone CLI for remote session control
packages/happy-app-logs # Log aggregation server for debugging
```

### Data Flow

1. **Authentication**: CLI generates a keypair; user scans a QR code with the mobile app to complete a challenge-response auth flow, producing a JWT.
2. **Session lifecycle**: CLI creates an encrypted session on the server and establishes a Socket.io WebSocket. The mobile/web app receives real-time updates over the same channel.
3. **Mode switching**: User can pause on desktop and resume from mobile (and vice versa) by pressing a key; the CLI toggles between interactive (PTY) and remote (SDK) mode.
4. **Encryption**: All sensitive content is encrypted client-side with libsodium (X25519 + ChaCha20-Poly1305) before leaving the device. The server never sees plaintext.

### Shared Protocol (`happy-wire`)

All message types, Zod schemas, and session protocol definitions live in `packages/happy-wire`. Any cross-package type change must start here. It exports both CommonJS and ESM, so changes require a build (`yarn workspace @slopus/happy-wire build`).

### Key Cross-Cutting Patterns

- **Package manager**: Always use `yarn` (v1.22.22), never npm.
- **Indentation**: 4 spaces across all packages.
- **TypeScript strict mode** is enabled everywhere. Run `yarn typecheck` after changes.
- **Testing**: Vitest is used in all packages. Test files use `.test.ts` (CLI) or `.spec.ts` (server) suffixes.
- **Imports**: Use `@/` path alias for within-package imports (maps to `sources/` or `src/`).
- **Standalone dev mode**: The server can run with an embedded PGlite database (no Docker needed) via `yarn standalone:dev` in `packages/happy-server`.

### nohoist Configuration

React, React Native, and a few related packages are `nohoist`ed in the root `package.json` to prevent version conflicts between the mobile app and other workspaces. When adding new React Native packages, check whether they also need to be added to the `nohoist` list.
