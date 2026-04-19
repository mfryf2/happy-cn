/**
 * Codex App Server Client — drives Codex via JSON-RPC 2.0 over stdio.
 *
 * Supports two transport modes:
 *  - `app-server` (upstream OpenAI Codex): `codex app-server --listen stdio://`
 *  - `mcp-server` (Tencent codex-internal): `codex-internal mcp-server` with direct gateway env injection
 *
 * Protocol: JSON-RPC 2.0 over stdio (newline-delimited JSON).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { logger } from '@/ui/logger';
import { execSync } from 'child_process';
import axios from 'axios';
import type {
    InitializeParams,
    NewConversationParams,
    NewConversationResponse,
    ResumeConversationParams,
    ResumeConversationResponse,
    InterruptConversationParams,
    ReviewDecision,
    EventMsg,
    JsonRpcRequest,
    JsonRpcResponse,
    ApprovalPolicy,
    SandboxMode,
    InputItem,
    ReasoningEffort,
    McpServerElicitationRequestResponse,
} from './codexAppServerTypes';
import type { SandboxConfig } from '@/persistence';
import { initializeSandbox, wrapForMcpTransport } from '@/sandbox/manager';
import packageJson from '../../package.json';
import type { ContentBlock, ImageUrlBlock } from '@slopus/happy-wire';

type PendingRequest = {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    method: string;
    epoch: number;
};

type LegacyPatchChanges = Record<string, Record<string, unknown>>;

export type ApprovalHandler = (params: {
    type: 'exec' | 'patch' | 'mcp';
    callId: string;
    command?: string[];
    cwd?: string;
    fileChanges?: Record<string, unknown>;
    reason?: string | null;
    toolName?: string;
    input?: unknown;
    serverName?: string;
    message?: string;
}) => Promise<ReviewDecision>;

/**
 * Detect which Codex binary is available and which mode to use.
 * Returns 'codex' for upstream OpenAI Codex (app-server mode),
 * 'codex-internal' for Tencent internal build (mcp-server mode),
 * or null if neither is found.
 */
function detectCodexBinary(): 'codex' | 'codex-internal' | null {
    try {
        const version = execSync('codex --version', { encoding: 'utf8', windowsHide: true }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+)/);
        if (match) {
            const [, ver] = match;
            const [major, minor] = ver.split('.').map(Number);
            if (major > 0 || minor >= 100) return 'codex';
        }
    } catch { }
    try {
        const out = execSync('codex-internal --version', { encoding: 'utf8', windowsHide: true }).trim();
        if (out.length > 0) return 'codex-internal';
    } catch { }
    return null;
}

/**
 * Load authentication environment variables for codex-internal (mcp-server mode).
 *
 * codex-internal's `mcp-server` subcommand bypasses its own `prepareEnvironment()`
 * (which is only called in interactive/login flows), so the internal gateway URL
 * and access token are never injected automatically.
 *
 * We replicate the same logic here:
 *  - Read accessToken from ~/.codex-internal/config.json
 *  - Set OPENAI_API_KEY / CODEX_API_KEY / AUTH_TOKEN to the accessToken
 *  - Clear any stale OPENAI_* and CODEX_INTERNAL_* env vars
 *  - Point openai_base_url directly at the internal gateway
 */
function loadCodexInternalEnv(env: Record<string, string>): void {
    const CODEX_INTERNAL_GATEWAY = 'https://copilot.code.woa.com/server/chat/codebuddy-gateway/codex';
    const configPath = join(homedir(), '.codex-internal', 'config.json');
    let accessToken: string | null = null;
    try {
        const raw = readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw) as { accessToken?: string };
        if (typeof parsed.accessToken === 'string' && parsed.accessToken.length > 0) {
            accessToken = parsed.accessToken;
        }
    } catch {
        logger.debug('[CodexAppServer] codex-internal: could not read config.json, skipping token injection');
    }
    // Clear upstream OPENAI_* AND CODEX_INTERNAL_* overrides
    for (const key of Object.keys(env)) {
        if (key.toUpperCase().startsWith('OPENAI_') || key.toUpperCase().startsWith('CODEX_INTERNAL_')) {
            delete env[key];
        }
    }
    // Inject internal gateway URL
    env.openai_base_url = CODEX_INTERNAL_GATEWAY;
    if (accessToken) {
        env.OPENAI_API_KEY = accessToken;
        env.CODEX_API_KEY = accessToken;
        env.AUTH_TOKEN = accessToken;
        logger.debug('[CodexAppServer] codex-internal: injected internal gateway and access token');
    } else {
        logger.warn('[CodexAppServer] codex-internal: no accessToken found in config.json — run `codex-internal` once to authenticate');
    }
}

function normalizeRawFileChangeList(changes: unknown): LegacyPatchChanges | undefined {
    if (!Array.isArray(changes)) {
        return undefined;
    }

    const normalized: LegacyPatchChanges = {};
    for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
            continue;
        }

        const path = typeof change.path === 'string' ? change.path : null;
        if (!path) {
            continue;
        }

        const entry: Record<string, unknown> = {};
        if (typeof change.diff === 'string') {
            entry.diff = change.diff;
        }
        if (change.kind && typeof change.kind === 'object' && !Array.isArray(change.kind)) {
            entry.kind = change.kind;
        }

        normalized[path] = entry;
    }

    return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Download an image from a URL to a temporary file and return the local path.
 * This allows Codex to receive the actual image bytes regardless of whether the
 * URL is publicly accessible (e.g. localhost-only dev URLs won't work for remote AI).
 */
async function downloadImageToTempFile(url: string): Promise<string> {
    const response = await axios.get<Buffer>(url, {
        responseType: 'arraybuffer',
        timeout: 30_000,
    });

    // Detect extension from Content-Type header, fall back to .jpg
    const contentType = (response.headers['content-type'] as string | undefined) ?? '';
    let ext = '.jpg';
    if (contentType.includes('png')) ext = '.png';
    else if (contentType.includes('gif')) ext = '.gif';
    else if (contentType.includes('webp')) ext = '.webp';

    const tempPath = join(tmpdir(), `codex-img-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
    writeFileSync(tempPath, Buffer.from(response.data));
    return tempPath;
}



export class CodexAppServerClient {
    private process: ChildProcess | null = null;
    private readline: ReadlineInterface | null = null;
    private nextId = 1;
    private pending = new Map<number, PendingRequest>();
    private processEpoch = 0;
    private connected = false;
    private sandboxConfig?: SandboxConfig;
    private sandboxCleanup: (() => Promise<void>) | null = null;
    public sandboxEnabled = false;

    /** Transport mode — set during connect() based on detected binary. */
    private mode: 'app-server' | 'mcp-server' = 'app-server';
    /** MCP mode: stores thread context since MCP has no thread/start RPC. */
    private mcpThreadContext: { model?: string; cwd?: string; approvalPolicy?: ApprovalPolicy; } | null = null;

    // Session state
    private _threadId: string | null = null;
    private _turnId: string | null = null;
    private threadDefaults: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    } | null = null;

    // Turn completion tracking for the currently active sendTurnAndWait call.
    // A completion event only resolves once we have seen task_started for this turn.
    private pendingTurnCompletion: {
        resolve: (aborted: boolean) => void;
        started: boolean;
        turnId: string | null;
    } | null = null;

    // Tracks in-flight interruptTurn() RPCs so sendTurnAndWait can wait for them
    // before starting a new turn (prevents stale turn/interrupt from aborting the next turn).
    private pendingInterrupt: Promise<void> | null = null;
    private notificationProtocol: 'unknown' | 'legacy' | 'raw' = 'unknown';
    private completedTurnIds = new Set<string>();
    private rawFileChangesByItemId = new Map<string, LegacyPatchChanges>();
    // Temp files created for the current turn's image downloads; cleaned up after sendTurnAndWait resolves.
    private _tempFilesForCurrentTurn: string[] = [];

    // Handlers set by the consumer (runCodex.ts)
    private eventHandler: ((msg: EventMsg) => void) | null = null;
    private approvalHandler: ApprovalHandler | null = null;

    constructor(sandboxConfig?: SandboxConfig) {
        this.sandboxConfig = sandboxConfig;
    }

    get threadId(): string | null {
        return this._threadId;
    }

    get turnId(): string | null {
        return this._turnId;
    }

    setEventHandler(handler: (msg: EventMsg) => void): void {
        this.eventHandler = handler;
    }

    setApprovalHandler(handler: ApprovalHandler): void {
        this.approvalHandler = handler;
    }

    private extractTurnId(params: any): string | null {
        const turnId = params?.turn?.id ?? params?.turnId ?? params?.turn_id ?? null;
        return typeof turnId === 'string' && turnId.length > 0 ? turnId : null;
    }

    private extractTurnStatus(params: any): string | null {
        const status = params?.turn?.status ?? params?.status ?? null;
        return typeof status === 'string' && status.length > 0 ? status : null;
    }

    private shouldHandleRawNotification(method: string): boolean {
        const isRawNotification = method === 'thread/started'
            || method === 'turn/started'
            || method === 'turn/completed'
            || method === 'thread/status/changed'
            || method === 'thread/tokenUsage/updated'
            || method.startsWith('item/');

        if (!isRawNotification) {
            return false;
        }

        if (this.notificationProtocol === 'legacy') {
            return false;
        }

        if (this.notificationProtocol === 'unknown') {
            this.notificationProtocol = 'raw';
        }

        return true;
    }

    private emitRawTurnCompletion(
        turnId: string | null,
        status: string | null,
        error: unknown,
        source: string,
    ): void {
        const aborted = status === 'cancelled' || status === 'canceled' || status === 'aborted' || status === 'interrupted';

        this.tryResolvePendingTurn(aborted, turnId, source);
        this._turnId = null;

        if (turnId && this.completedTurnIds.has(turnId)) {
            return;
        }
        if (turnId) {
            this.completedTurnIds.add(turnId);
        }

        if (aborted) {
            this.eventHandler?.({
                type: 'turn_aborted',
                ...(turnId ? { turn_id: turnId } : {}),
                ...(status ? { status } : {}),
                ...(error !== undefined && error !== null ? { error } : {}),
            });
            return;
        }

        this.eventHandler?.({
            type: 'task_complete',
            ...(turnId ? { turn_id: turnId } : {}),
            ...(status ? { status } : {}),
            ...(error !== undefined && error !== null ? { error } : {}),
        });
    }

    private handleRawNotification(method: string, params: any): boolean {
        if (!this.shouldHandleRawNotification(method)) {
            return false;
        }

        if (method === 'turn/started') {
            const turnId = this.extractTurnId(params);
            if (turnId) {
                this._turnId = turnId;
            }
            this.markPendingTurnStarted(turnId);
            this.eventHandler?.({
                type: 'task_started',
                ...(turnId ? { turn_id: turnId } : {}),
            });
            return true;
        }

        if (method === 'turn/completed') {
            this.emitRawTurnCompletion(
                this.extractTurnId(params),
                this.extractTurnStatus(params),
                params?.turn?.error ?? params?.error,
                method,
            );
            return true;
        }

        if (method === 'thread/status/changed') {
            const statusType = params?.status?.type;
            if (statusType === 'idle' && this.pendingTurnCompletion?.started) {
                this.emitRawTurnCompletion(this._turnId, 'completed', null, method);
            }
            return true;
        }

        if (method === 'thread/tokenUsage/updated') {
            const tokenUsage = params?.tokenUsage;
            if (tokenUsage && typeof tokenUsage === 'object') {
                this.eventHandler?.({
                    type: 'token_count',
                    ...tokenUsage,
                });
            }
            return true;
        }

        const item = params?.item;
        if (!item || typeof item !== 'object') {
            return method.startsWith('item/');
        }

        if (method === 'item/started' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_begin',
                call_id: callId,
                callId,
                command: item.command,
                cwd: item.cwd,
                description: item.command,
            });
            return true;
        }

        if (method === 'item/completed' && item.type === 'commandExecution') {
            const callId = typeof item.id === 'string' ? item.id : '';
            this.eventHandler?.({
                type: 'exec_command_end',
                call_id: callId,
                callId,
                output: item.aggregatedOutput ?? '',
                exit_code: item.exitCode ?? null,
                duration_ms: item.durationMs ?? null,
                status: item.status,
                cwd: item.cwd,
                command: item.command,
            });
            return true;
        }

        if (item.type === 'fileChange') {
            const callId = typeof item.id === 'string' ? item.id : '';
            const changes = normalizeRawFileChangeList(item.changes);

            if (callId && changes) {
                this.rawFileChangesByItemId.set(callId, changes);
            }

            if (method === 'item/started') {
                this.eventHandler?.({
                    type: 'patch_apply_begin',
                    call_id: callId,
                    callId,
                    changes: changes ?? {},
                });
                return true;
            }

            if (method === 'item/completed') {
                this.eventHandler?.({
                    type: 'patch_apply_end',
                    call_id: callId,
                    callId,
                    status: item.status,
                });

                if (callId && (item.status === 'completed' || item.status === 'failed' || item.status === 'declined')) {
                    this.rawFileChangesByItemId.delete(callId);
                }
                return true;
            }
        }

        if (method === 'item/completed' && item.type === 'agentMessage') {
            const text = typeof item.text === 'string' ? item.text : '';
            if (text.length > 0) {
                this.eventHandler?.({
                    type: 'agent_message',
                    message: text,
                    item_id: item.id,
                    phase: item.phase,
                });
            }

            if (item.phase === 'final_answer' && this.pendingTurnCompletion?.started) {
                this.emitRawTurnCompletion(
                    this.extractTurnId(params),
                    'completed',
                    null,
                    `${method}:final_answer`,
                );
            }
            return true;
        }

        return method.startsWith('item/');
    }

    // ─── Lifecycle ──────────────────────────────────────────────

    async connect(): Promise<void> {
        if (this.connected) return;

        const detectedBinary = detectCodexBinary();
        if (!detectedBinary) {
            throw new Error(
                'Codex CLI is not installed\n\n' +
                'Please install Codex CLI using one of these methods:\n\n' +
                'Option 1 - npm (recommended):\n  npm install -g @openai/codex\n\n' +
                'Option 2 - Homebrew (macOS):\n  brew install --cask codex\n\n' +
                'Alternatively, use Claude Code:\n  happy claude',
            );
        }

        // codex-internal uses mcp-server mode with direct gateway env injection.
        // Upstream codex uses app-server mode.
        this.mode = detectedBinary === 'codex-internal' ? 'mcp-server' : 'app-server';
        logger.debug(`[CodexAppServer] Detected binary: ${detectedBinary}, mode: ${this.mode}`);

        let command: string = detectedBinary;
        let args = this.mode === 'mcp-server' ? ['mcp-server'] : ['app-server', '--listen', 'stdio://'];
        this.sandboxEnabled = false;

        if (this.sandboxConfig?.enabled && process.platform !== 'win32') {
            try {
                this.sandboxCleanup = await initializeSandbox(this.sandboxConfig, process.cwd());
                const wrapped = await wrapForMcpTransport(detectedBinary, args);
                command = wrapped.command;
                args = wrapped.args;
                this.sandboxEnabled = true;
                logger.info(`[CodexAppServer] Sandbox enabled`);
            } catch (error) {
                logger.warn('[CodexAppServer] Failed to initialize sandbox; continuing without.', error);
                this.sandboxCleanup = null;
            }
        }

        // Build env — same filtering as the old MCP client
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === 'string') env[key] = value;
        }
        // Mute noisy rollout list logging
        const filter = 'codex_core::rollout::list=off';
        if (!env.RUST_LOG) {
            env.RUST_LOG = filter;
        } else if (!env.RUST_LOG.includes('codex_core::rollout::list=')) {
            env.RUST_LOG += `,${filter}`;
        }
        if (this.sandboxEnabled) {
            env.CODEX_SANDBOX = 'seatbelt';
        }

        // For codex-internal: inject internal gateway URL and access token directly
        if (detectedBinary === 'codex-internal') {
            loadCodexInternalEnv(env);
        }

        logger.debug(`[CodexAppServer] Spawning: ${command} ${args.join(' ')}`);

        const epoch = ++this.processEpoch;
        const proc = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            windowsHide: true,
        });
        this.process = proc;

        proc.on('error', (err) => {
            logger.debug('[CodexAppServer] Process error:', err);
        });

        proc.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            // Ignore stale process exits from prior generations during reconnect.
            if (this.process !== proc || this.processEpoch !== epoch) {
                logger.debug('[CodexAppServer] Ignoring stale process exit');
                return;
            }
            this.connected = false;
            // Reject all pending requests
            for (const [id, req] of this.pending) {
                if (req.epoch !== epoch) continue;
                req.reject(new Error(`Codex process exited (code=${code}) while waiting for ${req.method}`));
                this.pending.delete(id);
            }
            // Resolve pending turn completion (treat as abort)
            this.resolvePendingTurn(true);
        });

        // Pipe stderr for debug logging
        proc.stderr?.on('data', (chunk: Buffer) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            const text = chunk.toString().trim();
            if (text) logger.debug(`[CodexAppServer:stderr] ${text}`);
        });

        // Parse newline-delimited JSON from stdout
        this.readline = createInterface({ input: proc.stdout! });
        this.readline.on('line', (line) => {
            if (this.process !== proc || this.processEpoch !== epoch) return;
            this.handleLine(line, epoch);
        });

        if (this.mode === 'mcp-server') {
            // MCP initialize handshake
            await this.request('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: {
                    name: 'happy-codex',
                    version: packageJson.version,
                },
            });
            this.notify('notifications/initialized');
        } else {
            // app-server initialize handshake
            const initParams: InitializeParams = {
                clientInfo: {
                    name: 'happy-codex',
                    title: 'Happy Codex Client',
                    version: packageJson.version,
                },
                capabilities: {
                    experimentalApi: true,
                },
            };
            await this.request('initialize', initParams);
            this.notify('initialized');
        }

        this.connected = true;
        logger.debug(`[CodexAppServer] Connected and initialized (mode=${this.mode})`);
    }

    private async disconnectInternal(opts?: { preserveThreadState?: boolean }): Promise<void> {
        if (!this.connected && !this.process) return;

        const proc = this.process;
        const pid = proc?.pid;
        const epoch = this.processEpoch;
        logger.debug(`[CodexAppServer] Disconnecting; pid=${pid ?? 'none'}`);

        this.readline?.close();
        this.readline = null;

        try {
            proc?.stdin?.end();
            proc?.kill('SIGTERM');
        } catch { /* ignore */ }

        // Force kill after 2s (unref so timer doesn't block process exit)
        if (pid) {
            const killTimer = setTimeout(() => {
                try {
                    process.kill(pid, 0); // check alive
                    process.kill(pid, 'SIGKILL');
                } catch { /* already dead */ }
            }, 2000);
            killTimer.unref();
        }

        this.process = null;
        this.connected = false;
        this._turnId = null;
        this.notificationProtocol = 'unknown';
        this.completedTurnIds.clear();
        if (!opts?.preserveThreadState) {
            this._threadId = null;
            this.threadDefaults = null;
            this.mcpThreadContext = null;
        }

        // Fail in-flight requests from this process generation.
        for (const [id, req] of this.pending) {
            if (req.epoch !== epoch) continue;
            req.reject(new Error(`Codex process disconnected while waiting for ${req.method}`));
            this.pending.delete(id);
        }

        // Resolve pending turn completion (treat as abort)
        this.resolvePendingTurn(true);

        if (this.sandboxCleanup) {
            try { await this.sandboxCleanup(); } catch { /* ignore */ }
            this.sandboxCleanup = null;
        }
        this.sandboxEnabled = false;

        logger.debug('[CodexAppServer] Disconnected');
    }

    async disconnect(): Promise<void> {
        await this.disconnectInternal();
    }

    private buildThreadConfig(mcpServers?: Record<string, unknown>): Record<string, unknown> | null {
        return mcpServers ? { mcp_servers: mcpServers } : null;
    }

    private rememberThreadDefaults(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): void {
        this.threadDefaults = {
            model: opts.model,
            cwd: opts.cwd,
            approvalPolicy: opts.approvalPolicy,
            sandbox: opts.sandbox,
            mcpServers: opts.mcpServers,
        };
    }

    // ─── Thread management ──────────────────────────────────────

    async startThread(opts: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        if (this.mode === 'mcp-server') {
            // MCP mode: no thread/start RPC; create a pseudo thread-id and store context
            const pseudoThreadId = `mcp-pending-${Date.now()}`;
            this._threadId = pseudoThreadId;
            this._turnId = null;
            this.mcpThreadContext = {
                model: opts.model,
                cwd: opts.cwd ?? process.cwd(),
                approvalPolicy: opts.approvalPolicy,
            };
            this.rememberThreadDefaults(opts);
            logger.debug('[CodexAppServer] MCP thread context stored, pseudo-id:', pseudoThreadId);
            return { threadId: pseudoThreadId, model: opts.model ?? 'default' };
        }

        const params: NewConversationParams = {
            model: opts.model ?? null,
            modelProvider: null,
            profile: null,
            cwd: opts.cwd ?? process.cwd(),
            approvalPolicy: opts.approvalPolicy ?? null,
            sandbox: opts.sandbox ?? null,
            config: this.buildThreadConfig(opts.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            compactPrompt: null,
            includeApplyPatchTool: null,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/start', params) as NewConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.rememberThreadDefaults(opts);
        logger.debug('[CodexAppServer] Thread started:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async resumeThread(opts?: {
        threadId?: string;
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        mcpServers?: Record<string, unknown>;
    }): Promise<{ threadId: string; model: string }> {
        const threadId = opts?.threadId ?? this._threadId;
        if (!threadId) {
            throw new Error('No thread available to resume.');
        }

        if (this.mode === 'mcp-server') {
            // MCP mode: no resume RPC; update the stored context and use the threadId directly
            const defaults = this.threadDefaults ?? {};
            this._threadId = threadId;
            this._turnId = null;
            this.mcpThreadContext = {
                model: opts?.model ?? defaults.model,
                cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
                approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            };
            this.rememberThreadDefaults({
                model: opts?.model ?? defaults.model,
                cwd: opts?.cwd ?? defaults.cwd,
                approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
                sandbox: opts?.sandbox ?? defaults.sandbox,
                mcpServers: opts?.mcpServers ?? defaults.mcpServers,
            });
            logger.debug('[CodexAppServer] MCP thread context updated for resume:', threadId);
            return { threadId, model: opts?.model ?? defaults.model ?? 'default' };
        }

        const defaults = this.threadDefaults ?? {};
        const params: ResumeConversationParams = {
            threadId,
            model: opts?.model ?? defaults.model ?? null,
            modelProvider: null,
            cwd: opts?.cwd ?? defaults.cwd ?? process.cwd(),
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy ?? null,
            sandbox: opts?.sandbox ?? defaults.sandbox ?? null,
            config: this.buildThreadConfig(opts?.mcpServers ?? defaults.mcpServers),
            baseInstructions: null,
            developerInstructions: null,
            persistExtendedHistory: true,
        };

        const result = await this.request('thread/resume', params) as ResumeConversationResponse;
        this._threadId = result.thread.id;
        this._turnId = null;
        this.rememberThreadDefaults({
            model: opts?.model ?? defaults.model,
            cwd: opts?.cwd ?? defaults.cwd,
            approvalPolicy: opts?.approvalPolicy ?? defaults.approvalPolicy,
            sandbox: opts?.sandbox ?? defaults.sandbox,
            mcpServers: opts?.mcpServers ?? defaults.mcpServers,
        });
        logger.debug('[CodexAppServer] Thread resumed:', this._threadId);
        return { threadId: result.thread.id, model: result.model };
    }

    async reconnectAndResumeThread(): Promise<boolean> {
        const threadId = this._threadId;
        await this.disconnectInternal({ preserveThreadState: !!threadId });
        await this.connect();

        if (!threadId) {
            return false;
        }

        try {
            await this.resumeThread({ threadId });
            return true;
        } catch (error) {
            logger.warn('[CodexAppServer] Failed to resume thread after reconnect', error);
            this._threadId = null;
            this.threadDefaults = null;
            return false;
        }
    }

    // ─── Turn management ────────────────────────────────────────

    /** Default grace period after interrupt before forcing a restart (ms). */
    private static readonly ABORT_GRACE_MS = 3_000;

    private hasPendingTurnCompletion(): boolean {
        return this.pendingTurnCompletion !== null;
    }

    private resolvePendingTurn(aborted: boolean): void {
        if (!this.pendingTurnCompletion) return;
        this.pendingTurnCompletion.resolve(aborted);
        this.pendingTurnCompletion = null;
    }

    private markPendingTurnStarted(turnId?: string | null): void {
        if (!this.pendingTurnCompletion) return;
        this.pendingTurnCompletion.started = true;
        if (turnId) {
            this.pendingTurnCompletion.turnId = turnId;
        }
    }

    private tryResolvePendingTurn(aborted: boolean, turnId: string | null, source: string): void {
        const pending = this.pendingTurnCompletion;
        if (!pending) return;

        // Guard against stale completion notifications from the prior turn.
        if (!pending.started) {
            logger.debug(`[CodexAppServer] Ignoring ${source} before task_started`);
            return;
        }

        if (pending.turnId && turnId && pending.turnId !== turnId) {
            logger.debug(
                `[CodexAppServer] Ignoring ${source} for turn ${turnId}; awaiting ${pending.turnId}`,
            );
            return;
        }

        this.resolvePendingTurn(aborted);
    }

    private async waitForTurnCompletion(timeoutMs: number): Promise<boolean> {
        if (!this.hasPendingTurnCompletion()) {
            return true;
        }

        const deadline = Date.now() + Math.max(0, timeoutMs);
        while (this.hasPendingTurnCompletion()) {
            if (Date.now() >= deadline) {
                return false;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return true;
    }

    /**
     * Request turn interruption and optionally force-restart the app-server if
     * the turn does not settle within a short grace period.
     */
    async abortTurnWithFallback(opts?: {
        gracePeriodMs?: number;
        forceRestartOnTimeout?: boolean;
    }): Promise<{ hadActiveTurn: boolean; aborted: boolean; forcedRestart: boolean; resumedThread: boolean }> {
        const hadActiveTurn = this.hasPendingTurnCompletion();

        // No active turn pending in this client call-site.
        if (!hadActiveTurn) {
            return { hadActiveTurn: false, aborted: false, forcedRestart: false, resumedThread: false };
        }

        // Best-effort interrupt request first.
        await this.interruptTurn();

        const gracePeriodMs = opts?.gracePeriodMs ?? CodexAppServerClient.ABORT_GRACE_MS;
        const settled = await this.waitForTurnCompletion(gracePeriodMs);
        if (settled) {
            return { hadActiveTurn: true, aborted: true, forcedRestart: false, resumedThread: false };
        }

        const shouldForceRestart = opts?.forceRestartOnTimeout ?? true;
        if (!shouldForceRestart) {
            return { hadActiveTurn: true, aborted: false, forcedRestart: false, resumedThread: false };
        }

        logger.warn(`[CodexAppServer] interrupt did not settle turn in ${gracePeriodMs}ms; force-restarting app-server`);
        const pendingTurnId = this.pendingTurnCompletion?.turnId ?? this._turnId;
        if (this.pendingTurnCompletion?.started) {
            this.eventHandler?.({
                type: 'turn_aborted',
                reason: 'interrupted',
                ...(pendingTurnId ? { turn_id: pendingTurnId } : {}),
                forced_restart: true,
            });
        }
        const resumedThread = await this.reconnectAndResumeThread();
        return { hadActiveTurn: true, aborted: true, forcedRestart: true, resumedThread };
    }

    /**
     * Send a user turn and wait for it to complete.
     * Returns when task_complete or turn_aborted is received.
     */
    async sendTurn(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        blocks?: ContentBlock[];
    }): Promise<void> {
        if (!this._threadId) {
            throw new Error('No active thread. Call startThread first.');
        }

        if (this.mode === 'mcp-server') {
            // MCP mode: dispatch to the async MCP turn handler (non-blocking)
            this.sendTurnViaMcp(prompt, opts).catch((err) => {
                logger.debug('[CodexAppServer] sendTurnViaMcp error:', err);
                this.resolvePendingTurn(true);
            });
            return;
        }

        const input: InputItem[] = [];

        // Add text item only if there is text content
        if (prompt.trim().length > 0) {
            input.push({ type: 'text', text: prompt });
        }

        // Map image_url ContentBlocks to Codex InputItem localImages.
        // We download the image to a temp file so Codex receives the actual bytes
        // regardless of whether the URL is publicly reachable (e.g. localhost dev URLs).
        if (opts?.blocks) {
            for (const block of opts.blocks) {
                if (block.type === 'image_url') {
                    try {
                        const tempPath = await downloadImageToTempFile(block.url);
                        this._tempFilesForCurrentTurn.push(tempPath);
                        input.push({ type: 'localImage', path: tempPath });
                    } catch (err) {
                        logger.warn('[CodexAppServer] Failed to download image, falling back to URL:', block.url, err);
                        input.push({ type: 'image', url: block.url });
                    }
                }
            }
        }

        // Ensure there is at least one input item
        if (input.length === 0) {
            input.push({ type: 'text', text: prompt });
        }

        // Build params — only include optional fields when set (server uses thread defaults otherwise)
        const params: Record<string, unknown> = {
            threadId: this._threadId,
            input,
        };
        if (opts?.cwd) params.cwd = opts.cwd;
        if (opts?.approvalPolicy) params.approvalPolicy = opts.approvalPolicy;
        if (opts?.model) params.model = opts.model;
        if (opts?.effort) params.effort = opts.effort;

        // Map sandbox mode to the camelCase policy format the server expects
        if (opts?.sandbox) {
            switch (opts.sandbox) {
                case 'workspace-write':
                    params.sandboxPolicy = { type: 'workspaceWrite' };
                    break;
                case 'danger-full-access':
                    params.sandboxPolicy = { type: 'dangerFullAccess' };
                    break;
                case 'read-only':
                    params.sandboxPolicy = { type: 'readOnly' };
                    break;
            }
        }

        // turn/start returns immediately; turn completes via events.
        // We don't await completion here — the caller's event handler
        // tracks task_complete / turn_aborted.
        const result = await this.request('turn/start', params) as { turn?: { id?: string | null } };
        const turnId = result?.turn?.id;
        if (typeof turnId === 'string' && turnId.length > 0) {
            this._turnId = turnId;
            if (this.pendingTurnCompletion) {
                this.pendingTurnCompletion.turnId = turnId;
            }
        }
    }

    /**
     * Execute a complete MCP turn via tools/call.
     * Emits synthetic task_started, agent_message, task_complete events.
     * Long-running (~minutes); resolves pendingTurnCompletion when done.
     */
    private async sendTurnViaMcp(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        blocks?: ContentBlock[];
    }): Promise<void> {
        const ctx = this.mcpThreadContext ?? {};
        const isFirstTurn = this._threadId?.startsWith('mcp-pending-') ?? true;

        // Emit synthetic task_started so the UI shows activity
        this.markPendingTurnStarted(null);
        this.eventHandler?.({ type: 'task_started' });

        // Handle images: codex-internal MCP tool schema has no image parameters.
        // Strategy: download images to local temp files and embed their paths in the prompt.
        // The codex model will use its built-in view_image tool to read the files.
        //
        // Known limitation: codex-internal's view_image tool in MCP mode may return
        // re-encoded/resized images. The model still receives valid image data and can
        // usually describe the content, though accuracy may vary for some image types.
        let fullPrompt = prompt;
        if (opts?.blocks) {
            const imageBlocks = opts.blocks.filter((b): b is ImageUrlBlock => b.type === 'image_url');
            if (imageBlocks.length > 0) {
                logger.debug(`[CodexAppServer] MCP: ${imageBlocks.length} image(s) detected, downloading to temp files`);
                const downloadedPaths: string[] = [];
                for (const block of imageBlocks) {
                    try {
                        const tempPath = await downloadImageToTempFile(block.url);
                        this._tempFilesForCurrentTurn.push(tempPath);
                        downloadedPaths.push(tempPath);
                        logger.debug(`[CodexAppServer] MCP: downloaded image → ${tempPath}`);
                    } catch (err) {
                        logger.warn(`[CodexAppServer] MCP: failed to download image ${block.url}:`, err);
                    }
                }
                if (downloadedPaths.length > 0) {
                    const pathList = downloadedPaths.map((p) => `  - ${p}`).join('\n');
                    const imageInstruction =
                        `\n\n[The user attached ${downloadedPaths.length} image(s). ` +
                        `Please view the following image file(s) to see what they sent:\n${pathList}\n` +
                        `View each file and incorporate the image content into your response.]`;
                    fullPrompt = fullPrompt + imageInstruction;
                    logger.debug(`[CodexAppServer] MCP: injected ${downloadedPaths.length} image path(s) into prompt`);
                }
            }
        }

        const toolName = isFirstTurn ? 'codex' : 'codex-reply';
        const toolArgs: Record<string, unknown> = {
            prompt: fullPrompt,
            model: opts?.model ?? ctx.model,
            cwd: opts?.cwd ?? ctx.cwd ?? process.cwd(),
        };
        if (isFirstTurn) {
            // First turn: include full context
            if (opts?.approvalPolicy ?? ctx.approvalPolicy) {
                toolArgs.approval_policy = opts?.approvalPolicy ?? ctx.approvalPolicy;
            }
        } else {
            // Subsequent turns: include thread_id
            toolArgs.thread_id = this._threadId;
        }

        logger.debug(`[CodexAppServer] MCP tools/call: ${toolName}`, toolArgs);

        const result = await this.request('tools/call', {
            name: toolName,
            arguments: toolArgs,
        }, CodexAppServerClient.TURN_TIMEOUT_MS) as {
            content?: Array<{ type: string; text?: string }>;
            _meta?: { thread_id?: string };
            isError?: boolean;
        };

        // Extract real threadId from result if this was the first turn.
        // codex-internal returns {threadId, content} as JSON inside content[0].text,
        // NOT in result._meta.thread_id — parse accordingly.
        if (isFirstTurn) {
            const textContent = result?.content?.find((c) => c.type === 'text')?.text;
            if (textContent) {
                try {
                    const parsed = JSON.parse(textContent) as { threadId?: string; content?: string };
                    if (typeof parsed.threadId === 'string' && parsed.threadId.length > 0) {
                        this._threadId = parsed.threadId;
                        logger.debug('[CodexAppServer] MCP real threadId from content:', parsed.threadId);
                    }
                } catch {
                    // Not JSON — fallback to checking _meta (upstream Codex may use this)
                    const metaThreadId = result?._meta?.thread_id;
                    if (typeof metaThreadId === 'string' && metaThreadId.length > 0) {
                        this._threadId = metaThreadId;
                        logger.debug('[CodexAppServer] MCP real threadId from _meta:', metaThreadId);
                    }
                }
            }
        }

        // Extract text response from content array.
        // codex-internal wraps its response as JSON {threadId, content} in content[0].text;
        // upstream Codex returns plain text. Handle both.
        const rawText = result?.content
            ?.filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text ?? '')
            .join('')
            .trim() ?? '';
        let text = rawText;
        if (rawText.length > 0) {
            try {
                const parsed = JSON.parse(rawText) as { threadId?: string; content?: string };
                if (typeof parsed.content === 'string') {
                    text = parsed.content;
                }
            } catch {
                // Plain text — use as-is
            }
        }

        if (text.length > 0) {
            this.eventHandler?.({
                type: 'agent_message',
                message: text,
            });
        }

        const aborted = result?.isError === true;
        this.eventHandler?.({
            type: aborted ? 'turn_aborted' : 'task_complete',
        });
        this.tryResolvePendingTurn(aborted, null, 'mcp-tools/call');
        this._turnId = null;
    }

    /** Default timeout for waiting on turn completion (ms). 10 minutes. */
    private static readonly TURN_TIMEOUT_MS = 10 * 60 * 1000;

    /**
     * Send a user turn and wait for it to complete (task_complete or turn_aborted).
     * Returns { aborted: true } if the turn was aborted (user cancel, permission reject, etc.).
     */
    async sendTurnAndWait(prompt: string, opts?: {
        model?: string;
        cwd?: string;
        approvalPolicy?: ApprovalPolicy;
        sandbox?: SandboxMode;
        effort?: ReasoningEffort;
        turnTimeoutMs?: number;
        blocks?: ContentBlock[];
    }): Promise<{ aborted: boolean }> {
        // Wait for any in-flight interruptTurn() to complete before starting a new
        // turn. Otherwise the stale turn/interrupt RPC can reach Codex after our
        // turn/start and abort the wrong turn.
        if (this.pendingInterrupt) {
            await this.pendingInterrupt;
            // Yield to the event loop so any stale turn_aborted/task_complete
            // notifications queued by the interrupted turn are processed now
            // (harmlessly, since pendingTurnCompletion is null at this point).
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Reset temp file tracking for this turn
        this._tempFilesForCurrentTurn = [];

        const timeoutMs = opts?.turnTimeoutMs ?? CodexAppServerClient.TURN_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const completion = new Promise<boolean>((resolve) => {
            this.pendingTurnCompletion = {
                resolve,
                started: false,
                turnId: null,
            };

            timer = setTimeout(() => {
                if (this.pendingTurnCompletion) {
                    logger.warn(`[CodexAppServer] Turn timed out after ${timeoutMs}ms — treating as abort`);
                    this.resolvePendingTurn(true);
                }
            }, timeoutMs);
        });

        try {
            await this.sendTurn(prompt, opts);
        } catch (err) {
            if (timer) clearTimeout(timer);
            this.pendingTurnCompletion = null;
            this.cleanupTempFiles();
            throw err;
        }

        const aborted = await completion;
        if (timer) clearTimeout(timer);
        this.cleanupTempFiles();
        return { aborted };
    }

    /** Remove any temp image files created during the last turn. */
    private cleanupTempFiles(): void {
        for (const filePath of this._tempFilesForCurrentTurn) {
            try {
                unlinkSync(filePath);
            } catch {
                // Ignore — file may already be gone
            }
        }
        this._tempFilesForCurrentTurn = [];
    }

    async interruptTurn(): Promise<void> {
        if (this.mode === 'mcp-server') {
            logger.debug('[CodexAppServer] interruptTurn: no-op in mcp-server mode');
            return;
        }
        if (!this._threadId) return;
        if (!this._turnId) {
            logger.debug('[CodexAppServer] interruptTurn: no active turnId, skipping');
            return;
        }
        const params: InterruptConversationParams = {
            threadId: this._threadId,
            turnId: this._turnId,
        };
        const doInterrupt = async () => {
            try {
                await this.request('turn/interrupt', params);
            } catch (err) {
                // Ignore if no turn is active
                logger.debug('[CodexAppServer] interruptTurn error (may be expected):', err);
            } finally {
                this.pendingInterrupt = null;
            }
        };
        this.pendingInterrupt = doInterrupt();
        return this.pendingInterrupt;
    }

    // ─── State queries ──────────────────────────────────────────

    hasActiveThread(): boolean {
        return this._threadId !== null;
    }

    // ─── JSON-RPC transport ─────────────────────────────────────

    /** Default timeout for RPC requests (ms). */
    private static readonly REQUEST_TIMEOUT_MS = 30_000;

    private request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
        const timeout = timeoutMs ?? CodexAppServerClient.REQUEST_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            if (!this.process?.stdin?.writable) {
                reject(new Error(`Cannot send ${method}: stdin not writable`));
                return;
            }
            const id = this.nextId++;

            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeout}ms (id=${id})`));
            }, timeout);

            this.pending.set(id, {
                resolve: (result) => { clearTimeout(timer); resolve(result); },
                reject: (err) => { clearTimeout(timer); reject(err); },
                method,
                epoch: this.processEpoch,
            });

            const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
            const line = JSON.stringify(msg) + '\n';
            logger.debug(`[CodexAppServer] → ${method} (id=${id})`);
            this.process.stdin.write(line);
        });
    }

    private notify(method: string, params?: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → ${method} (notification)`);
    }

    private respond(id: number, result: unknown): void {
        if (!this.process?.stdin?.writable) return;
        const msg: JsonRpcResponse = { jsonrpc: '2.0', id, result };
        this.process.stdin.write(JSON.stringify(msg) + '\n');
        logger.debug(`[CodexAppServer] → response (id=${id})`);
    }

    private handleLine(line: string, sourceEpoch: number = this.processEpoch): void {
        if (sourceEpoch !== this.processEpoch) {
            return;
        }
        if (!line.trim()) return;

        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            logger.debug('[CodexAppServer] Non-JSON line:', line.substring(0, 200));
            return;
        }

        // Response to our request
        if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
            const pending = this.pending.get(msg.id);
            if (pending) {
                if (pending.epoch !== sourceEpoch) {
                    logger.debug(`[CodexAppServer] Ignoring response from stale epoch for id=${msg.id}`);
                    return;
                }
                this.pending.delete(msg.id);
                if (msg.error) {
                    pending.reject(new Error(`${pending.method}: ${msg.error.message} (code=${msg.error.code})`));
                } else {
                    pending.resolve(msg.result);
                }
            }
            return;
        }

        // Server → client request (approvals)
        if (msg.id != null && msg.method) {
            this.handleServerRequest(msg.id, msg.method, msg.params).catch((err) => {
                logger.debug('[CodexAppServer] Error handling server request:', err);
            });
            return;
        }

        // Notification (no id)
        if (msg.method) {
            this.handleNotification(msg.method, msg.params);
            return;
        }

        logger.debug('[CodexAppServer] Unhandled message:', JSON.stringify(msg).substring(0, 300));
    }

    /**
     * Map our internal ReviewDecision to the wire format the server expects.
     * Server uses: accept, acceptForSession, decline, cancel
     * Our handler uses: approved, approved_for_session, denied, abort
     */
    /**
     * Map our internal ReviewDecision to the wire format codex expects.
     * v2 methods (item/*) use: accept/acceptForSession/decline/cancel
     * Legacy methods (execCommandApproval/applyPatchApproval) use: approved/approved_for_session/denied/abort
     */
    private mapDecisionToWire(decision: ReviewDecision, legacy: boolean): string | Record<string, unknown> {
        if (typeof decision === 'string') {
            if (legacy) {
                // Legacy wire format — pass through as-is (approved/denied/abort)
                return decision;
            }
            // v2 wire format
            switch (decision) {
                case 'approved': return 'accept';
                case 'approved_for_session': return 'acceptForSession';
                case 'denied': return 'decline';
                case 'abort': return 'cancel';
                default: return 'decline';
            }
        }
        // Object variant: approved_execpolicy_amendment → pass through as-is
        if ('approved_execpolicy_amendment' in decision) {
            return decision;
        }
        return legacy ? 'denied' : 'decline';
    }

    private parseToolNameFromElicitationMessage(message: unknown): string | null {
        if (typeof message !== 'string') {
            return null;
        }
        const match = message.match(/tool "([^"]+)"/i);
        return match?.[1] ?? null;
    }

    private mapDecisionToMcpElicitationResponse(
        decision: ReviewDecision,
        params: any,
    ): McpServerElicitationRequestResponse {
        if (typeof decision === 'string') {
            switch (decision) {
                case 'approved':
                case 'approved_for_session':
                    return {
                        action: 'accept',
                        content: params?.mode === 'form' ? {} : null,
                        _meta: null,
                    };
                case 'abort':
                    return {
                        action: 'cancel',
                        content: null,
                        _meta: null,
                    };
                case 'denied':
                default:
                    return {
                        action: 'decline',
                        content: null,
                        _meta: null,
                    };
            }
        }

        return {
            action: 'decline',
            content: null,
            _meta: null,
        };
    }

    private async handleServerRequest(id: number, method: string, params: any): Promise<void> {
        if (method === 'mcpServer/elicitation/request') {
            const toolName = this.parseToolNameFromElicitationMessage(params?.message) ?? params?.serverName ?? 'McpTool';
            const decision = await this.handleApproval({
                type: 'mcp',
                callId: `${params?.serverName ?? 'mcp'}:${id}`,
                toolName,
                input: params?._meta?.tool_params ?? {},
                serverName: params?.serverName,
                message: params?.message,
            });
            this.respond(id, this.mapDecisionToMcpElicitationResponse(decision, params));
            return;
        }

        // Command execution approval
        if (method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval') {
            const legacy = method === 'execCommandApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'exec',
                callId,
                command: params.command != null ? [params.command] : [],
                cwd: params.cwd,
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // File change / patch approval
        if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
            const legacy = method === 'applyPatchApproval';
            const callId = params.itemId ?? params.callId ?? String(id);
            const decision = await this.handleApproval({
                type: 'patch',
                callId,
                fileChanges: params.fileChanges ?? (typeof callId === 'string'
                    ? this.rawFileChangesByItemId.get(callId)
                    : undefined),
                reason: params.reason,
            });
            this.respond(id, { decision: this.mapDecisionToWire(decision, legacy) });
            return;
        }

        // Unknown server request — respond so server doesn't hang
        logger.debug(`[CodexAppServer] Unknown server request: ${method}`);
        this.respond(id, {});
    }

    private async handleApproval(params: Parameters<ApprovalHandler>[0]): Promise<ReviewDecision> {
        if (this.approvalHandler) {
            try {
                return await this.approvalHandler(params);
            } catch (err) {
                logger.debug('[CodexAppServer] Approval handler error:', err);
                return 'denied';
            }
        }
        return 'denied'; // default: deny if no handler
    }

    private handleNotification(method: string, params: any): void {
        // codex/event notifications: either `codex/event` or `codex/event/<type>`
        if (method === 'codex/event' || method.startsWith('codex/event/')) {
            this.notificationProtocol = 'legacy';
            const msg = params?.msg;
            if (msg) {
                // Extract turn_id from task_started events
                if (msg.type === 'task_started' && msg.turn_id) {
                    this._turnId = msg.turn_id;
                }
                if (msg.type === 'task_started') {
                    this.markPendingTurnStarted(msg.turn_id ?? msg.turnId ?? null);
                }
                // Fire event handler first (so consumer processes the event)
                this.eventHandler?.(msg);
                // Then resolve turn completion promise
                if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
                    const turnId = msg.turn_id ?? msg.turnId ?? null;
                    // Mark as completed so v2 turn/completed doesn't duplicate
                    if (turnId) {
                        this.completedTurnIds.add(turnId);
                    }
                    this.tryResolvePendingTurn(
                        msg.type === 'turn_aborted',
                        turnId,
                        `codex/event/${msg.type}`,
                    );
                    this._turnId = null;
                }
            }
            return;
        }

        if (this.handleRawNotification(method, params)) {
            logger.debug(`[CodexAppServer] Raw notification: ${method}`);
            return;
        }

        // v2 lifecycle notifications
        if (method === 'thread/started' || method === 'turn/started' ||
            method === 'turn/completed' || method === 'thread/status/changed') {
            logger.debug(`[CodexAppServer] Lifecycle notification: ${method}`);
            // Mark the turn as started so the completion guard lets it through.
            if (method === 'turn/started') {
                const turnId = this.extractTurnId(params);
                if (turnId) {
                    this._turnId = turnId;
                }
                this.markPendingTurnStarted(turnId);
            }
            // turn/completed is a fallback signal — for mid-inference interrupts,
            // Codex may only signal completion here (not via codex/event turn_aborted).
            // emitRawTurnCompletion deduplicates via completedTurnIds if legacy already handled it.
            if (method === 'turn/completed') {
                this.emitRawTurnCompletion(
                    this.extractTurnId(params),
                    this.extractTurnStatus(params),
                    params?.turn?.error ?? params?.error,
                    method,
                );
            }
            return;
        }

        logger.debug(`[CodexAppServer] Notification: ${method}`);
    }
}
