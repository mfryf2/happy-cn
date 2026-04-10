# Fork Changes

This document records all customizations made in this fork (`mfryf2/happy-cn`) relative to the upstream repository (`slopus/happy`).

**Purpose**: Use this as a checklist when syncing upstream to quickly identify what needs to be preserved or re-applied.

---

## Active Customizations

### 1. Image Upload (Full Stack)

**Status**: Active — not in upstream  
**Commits**: `87118cfb`, `7011956f`, `f1ba435e`, `20564da5`

**Files modified**:
- `packages/happy-app/sources/sync/apiUpload.ts` — new file, image upload API client
- `packages/happy-app/sources/components/AgentInput.tsx` — web drag-and-drop, clipboard paste
- `packages/happy-app/sources/components/MessageView.tsx` — image rendering in messages
- `packages/happy-app/sources/sync/reducer/reducer.ts` — ContentBlock support, image in user messages
- `packages/happy-app/sources/sync/typesMessage.ts` — `image_url` ContentBlock type
- `packages/happy-app/sources/sync/typesRaw.ts` — raw message types for images
- `packages/happy-app/sources/-session/SessionView.tsx` — `onSendWithImages` callback wiring
- `packages/happy-server/sources/app/api/routes/uploadRoutes.ts` — server upload endpoint
- `packages/happy-server/sources/app/api/api.ts` — route registration
- `packages/happy-cli/src/claude/runClaude.ts` — forward image content blocks to Claude
- `packages/happy-wire/src/legacyProtocol.ts` — wire protocol support for images

**What it does**: Users can paste (Ctrl+V/Cmd+V) or drag-and-drop images on the web UI. Images are uploaded to the server and sent to the AI agent as image content blocks.

---

### 2. China Mainland Adaptation

**Status**: Active — not suitable for upstream  
**Commit**: `d6500c82`

**Files modified**:
- `packages/happy-cli/src/utils/detectCLI.ts` — support custom Claude Code binary path
- `packages/happy-cli/src/claude/claudeLocalLauncher.ts` — custom launcher path
- `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` — custom remote launcher path

**What it does**: Allows using a locally customized Claude Code binary and self-hosted server, working around access restrictions in mainland China.

> **Note**: This should NOT be submitted as a PR to upstream. It's specific to mainland China infrastructure.

---

### 3. Permission Button UX Fix

**Status**: Active — potential upstream PR candidate  
**Commits**: `0e85f357`, `90bb0ae0`, `561bf1b2`

**Files modified**:
- `packages/happy-app/sources/components/tools/PermissionFooter.tsx` — local `selectedAction` state to track which button was clicked
- `packages/happy-app/sources/sync/reducer/reducer.ts` — pass through `mode`, `allowedTools`, `decision` fields
- `packages/happy-cli/src/api/types.ts` — type updates
- `packages/happy-cli/src/claude/utils/permissionHandler.ts` — permission handler improvements

**What it does**: Fixes permission confirmation button highlight/grey state. The server doesn't always return `allowedTools`, so we track user intent locally with `selectedAction` state.

---

### 4. Deployment Scripts

**Status**: Active — not suitable for upstream (self-hosted specific)  
**Commits**: `26351725`, `89cb63a3`, `cb1c2a81`

**Files**:
- `scripts/deploy.sh` — one-click full deployment script
- `scripts/update-server.sh` — update server-side code
- `scripts/update-local.sh` — update local development environment

**What it does**: Convenience scripts for self-hosted deployment management.

> **Note**: These are self-hosted deployment tools. Upstream may not want them, but they don't conflict.

---

### 5. Documentation

**Status**: Active — fork-specific docs  
**Commits**: `82c7b33d`, `716d4567`, `05e1de6f`, `1387d12e`, `e311611e`

**Files**:
- `CLAUDE.md` — monorepo navigation guide for AI assistants
- `packages/happy-app/COMPONENT_ANALYSIS.md` — component analysis
- `packages/happy-app/COMPONENT_QUICK_REFERENCE.md` — quick reference
- `packages/happy-app/FILE_INDEX.md` — file index

---

## Sync History

| Date | Upstream Commit | Notes |
|------|----------------|-------|
| 2026-04-08 | `feda13f6` | First sync after fork. Merged: voice paywall, Gemini 3.x, Codex daemon auto-start, effort level, markdown fixes. Conflict: CHANGELOG version number (resolved by bumping our v7 to v8). |

---

## Upstream Sync Checklist

When running `git fetch upstream && git merge upstream/main`:

1. **Check CHANGELOG.md** — both sides may add Version entries. Bump your version number to avoid conflict.
2. **Check `AgentInput.tsx`** — upstream actively changes this file. Verify image upload code is preserved.
3. **Check `reducer.ts`** — upstream actively changes this file. Verify `mode`/`allowedTools`/`decision` passthrough is preserved.
4. **Check `PermissionFooter.tsx`** — verify `selectedAction` state is preserved.
5. **Check `uploadRoutes.ts`** on server side — upstream changes `voiceRoutes.ts` nearby, watch for conflicts.

---

## PR Candidates for Upstream

### High chance of acceptance: Permission Button UX Fix

The `selectedAction` fix in `PermissionFooter.tsx` addresses a real UX bug where button highlights are wrong because the server doesn't reliably return `allowedTools`. This is a pure bug fix with no China-specific logic.

**How to submit**:
1. Create a branch from upstream's `main`: `git checkout -b fix/permission-button-highlight upstream/main`
2. Cherry-pick only the permission fix commits: `git cherry-pick 0e85f357 90bb0ae0 561bf1b2`
3. Remove any unrelated changes, write a clear PR description with a screen recording
4. Follow upstream's PR rules (see `docs/CONTRIBUTING.md`): one-paragraph summary, proof it works, pass Codex review first

### Low chance of acceptance: Image Upload

The image upload feature modifies many core files (reducer, wire protocol, server). Upstream would need to review architecture decisions carefully. Additionally, the current implementation may conflict with their roadmap.

**Recommendation**: Wait and see if upstream adds image support themselves. If not after 3-6 months, try submitting.
