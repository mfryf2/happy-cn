/**
 * CodexAppServerBackend - Codex app-server WebSocket backend
 *
 * This module implements the AgentBackend interface for the native Codex binary
 * using the `codex app-server` WebSocket RPC protocol — the same protocol used
 * by the official Codex desktop app.
 *
 * Architecture:
 *   1. Spawn `codex app-server --listen ws://127.0.0.1:{PORT} [--ws-auth capability-token --ws-token-file PATH]`
 *   2. Connect via WebSocket
 *   3. Send `initialize` → receive InitializeResponse
 *   4. Send `thread/start` → receive ThreadStartedNotification (thread ID)
 *   5. Send `turn/start` with user input → stream AgentMessageDeltaNotification → TurnCompletedNotification
 *   6. Handle `item/commandExecution/requestApproval` / `item/fileChange/requestApproval` server requests
 *
 * The native binary communicates over a structured JSON RPC protocol (not ACP/ndjson).
 * Each message is a JSON object with `method`, optional `id`, and optional `params`/`result`/`error`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';
import type {
    AgentBackend,
    AgentMessage,
    AgentMessageHandler,
    SessionId,
    StartSessionResult,
    McpServerConfig,
} from '../core';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';
import type { ContentBlock } from '@/api/types';

// ─── Protocol types (inline subset, no external dep needed) ───────────────────

interface RpcRequest {
    id: string;
    method: string;
    params?: unknown;
}

interface RpcResponse {
    id: string;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface RpcNotification {
    method: string;
    params?: unknown;
}

type WireMessage = RpcRequest | RpcResponse | RpcNotification;

// ─── Options ──────────────────────────────────────────────────────────────────

export interface CodexAppServerOptions {
    /** Agent name for identification */
    agentName?: string;

    /** Working directory for the agent */
    cwd: string;

    /** Path to the codex binary. Defaults to 'codex-internal' falling back to 'codex'. */
    codexBinary?: string;

    /** Model to use (e.g. 'codex-1', 'o4-mini', 'gpt-4o') */
    model?: string;

    /** Approval policy: 'auto' auto-approves everything, 'on-failure' approves on failure */
    approvalPolicy?: 'suggest' | 'auto-edit' | 'full-auto' | 'on-failure' | 'never';

    /** Environment variables to pass to the agent */
    env?: Record<string, string>;

    /** MCP servers to make available to the agent */
    mcpServers?: Record<string, McpServerConfig>;

    /** If true, automatically approve all tool/exec/file requests */
    autoApprove?: boolean;
}

// ─── Internal state ───────────────────────────────────────────────────────────

interface PendingRequest {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
}

interface SessionState {
    sessionId: SessionId;
    threadId: string;
    turnId: string | null;
    isRunning: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const WS_HANDSHAKE_TIMEOUT_MS = 15_000;
const RPC_REQUEST_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 300_000; // 5 minutes
const BINARY_START_TIMEOUT_MS = 10_000;
const PORT_SCAN_RANGE_START = 49200;
const PORT_SCAN_RANGE_END = 49900;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Find an available TCP port in a range */
async function findAvailablePort(start: number, end: number): Promise<number> {
    for (let port = start; port <= end; port++) {
        const available = await isPortAvailable(port);
        if (available) return port;
    }
    throw new Error(`No available port found in range ${start}–${end}`);
}

function isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => {
            server.close(() => resolve(true));
        });
        server.listen(port, '127.0.0.1');
    });
}

/** Write a random capability token to a temp file and return {token, path} */
async function createCapabilityToken(): Promise<{ token: string; tokenFile: string }> {
    const token = randomUUID().replace(/-/g, '');
    const tokenFile = join(tmpdir(), `codex-token-${randomUUID()}.txt`);
    await fsp.writeFile(tokenFile, token, 'utf8');
    return { token, tokenFile };
}

/** Wait for the app-server to start accepting WebSocket connections */
async function waitForServerReady(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const reachable = await isPortListening(port);
        if (reachable) return;
        await delay(200);
    }
    throw new Error(`codex app-server did not start within ${timeoutMs}ms on port ${port}`);
}

function isPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('error', () => resolve(false));
    });
}

// ─── Main class ───────────────────────────────────────────────────────────────

/**
 * AgentBackend implementation that uses the native Codex binary's
 * `app-server` WebSocket RPC protocol.
 */
export class CodexAppServerBackend implements AgentBackend {
    private readonly opts: Required<
        Pick<CodexAppServerOptions, 'agentName' | 'cwd' | 'autoApprove' | 'approvalPolicy'>
    > &
        CodexAppServerOptions;

    private process: ChildProcess | null = null;
    private ws: WebSocket | null = null;
    private port = 0;
    private tokenFile: string | null = null;

    /** Pending RPC requests keyed by id */
    private pendingRequests = new Map<string, PendingRequest>();

    /** Registered message handlers */
    private messageHandlers: Set<AgentMessageHandler> = new Set();

    /** Active session state */
    private session: SessionState | null = null;

    /** Promise that resolves/rejects when the current turn completes */
    private turnCompletionSignal: {
        resolve: () => void;
        reject: (err: Error) => void;
    } | null = null;

    /** Accumulated text of the current turn */
    private currentTextBuffer = '';

    constructor(opts: CodexAppServerOptions) {
        this.opts = {
            ...opts,
            agentName: opts.agentName ?? 'codex',
            approvalPolicy: opts.approvalPolicy ?? 'suggest',
            autoApprove: opts.autoApprove ?? false,
        };
    }

    // ── AgentBackend interface ─────────────────────────────────────────────────

    async startSession(initialPrompt?: string): Promise<StartSessionResult> {
        const sessionId = randomUUID();
        logger.debug(`[CodexAppServer] Starting session ${sessionId}`);

        await this._spawnAndConnect();

        // Initialize protocol
        const initResult = await this._request('initialize', {
            clientInfo: { name: 'happy-cli', version: '1.0.0' },
            capabilities: null,
        });
        logger.debug('[CodexAppServer] Initialized:', (initResult as Record<string, unknown>).userAgent ?? '');

        // Start thread
        const threadResult = await this._request('thread/start', {
            cwd: this.opts.cwd,
            approvalPolicy: this._mapApprovalPolicy(this.opts.approvalPolicy),
            experimentalRawEvents: false,
            persistExtendedHistory: false,
            ...(this.opts.model ? { model: this.opts.model } : {}),
        });
        const threadId = (threadResult as { thread: { id: string } }).thread.id;
        logger.debug(`[CodexAppServer] Thread started: ${threadId}`);

        this.session = {
            sessionId,
            threadId,
            turnId: null,
            isRunning: false,
        };

        this._emit({ type: 'status', status: 'idle' });

        // Send initial prompt if provided
        if (initialPrompt) {
            await this.sendPrompt(sessionId, initialPrompt);
        }

        return { sessionId };
    }

    async sendPrompt(sessionId: SessionId, prompt: string, blocks?: ContentBlock[]): Promise<void> {
        if (!this.session || this.session.sessionId !== sessionId) {
            throw new Error(`[CodexAppServer] Unknown session: ${sessionId}`);
        }
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('[CodexAppServer] WebSocket not connected');
        }
        if (this.session.isRunning) {
            logger.warn('[CodexAppServer] Turn already in progress, ignoring sendPrompt');
            return;
        }

        this.session.isRunning = true;
        this.session.turnId = null;
        this.currentTextBuffer = '';

        // Build input array
        const input: unknown[] = [
            { type: 'text', text: prompt, text_elements: [] },
        ];

        // Attach any image blocks
        if (blocks) {
            for (const block of blocks) {
                if (block.type === 'image_url') {
                    input.push({ type: 'image', url: block.url });
                }
            }
        }

        this._emit({ type: 'status', status: 'running' });

        // Set up turn completion signal
        const turnComplete = new Promise<void>((resolve, reject) => {
            this.turnCompletionSignal = { resolve, reject };
        });

        try {
            await this._request('turn/start', {
                threadId: this.session.threadId,
                input,
            });
        } catch (err) {
            this.session.isRunning = false;
            this.turnCompletionSignal = null;
            this._emit({ type: 'status', status: 'error', detail: String(err) });
            throw err;
        }

        // Wait for turn to complete (or timeout)
        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Turn timed out')), TURN_TIMEOUT_MS)
        );

        try {
            await Promise.race([turnComplete, timeout]);
        } finally {
            this.session.isRunning = false;
            this.turnCompletionSignal = null;
        }
    }

    async cancel(sessionId: SessionId): Promise<void> {
        if (!this.session || this.session.sessionId !== sessionId) return;

        const { threadId, turnId } = this.session;
        if (turnId) {
            try {
                await this._request('turn/interrupt', { threadId, turnId });
            } catch (err) {
                logger.warn('[CodexAppServer] Failed to interrupt turn:', err);
            }
        }

        if (this.turnCompletionSignal) {
            this.turnCompletionSignal.reject(new Error('Cancelled by user'));
            this.turnCompletionSignal = null;
        }
        this.session.isRunning = false;
        this._emit({ type: 'status', status: 'idle' });
    }

    onMessage(handler: AgentMessageHandler): void {
        this.messageHandlers.add(handler);
    }

    offMessage(handler: AgentMessageHandler): void {
        this.messageHandlers.delete(handler);
    }

    async respondToPermission(requestId: string, approved: boolean): Promise<void> {
        this._emit({ type: 'permission-response', id: requestId, approved });
    }

    async waitForResponseComplete(timeoutMs = TURN_TIMEOUT_MS): Promise<void> {
        if (!this.session?.isRunning) return;

        const deadline = Date.now() + timeoutMs;
        while (this.session?.isRunning && Date.now() < deadline) {
            await delay(100);
        }

        if (this.session?.isRunning) {
            throw new Error('waitForResponseComplete timed out');
        }
    }

    async dispose(): Promise<void> {
        logger.debug('[CodexAppServer] Disposing');

        // Cancel any in-flight turn
        if (this.turnCompletionSignal) {
            this.turnCompletionSignal.reject(new Error('Disposed'));
            this.turnCompletionSignal = null;
        }

        // Cancel all pending RPC requests
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeoutHandle);
            pending.reject(new Error('Disposed'));
            this.pendingRequests.delete(id);
        }

        // Close WebSocket
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }

        // Kill process
        if (this.process) {
            this.process.removeAllListeners();
            try {
                this.process.kill('SIGTERM');
            } catch {
                // ignore
            }
            this.process = null;
        }

        // Clean up token file
        if (this.tokenFile) {
            try {
                await fsp.unlink(this.tokenFile);
            } catch {
                // ignore
            }
            this.tokenFile = null;
        }

        this.session = null;
        this._emit({ type: 'status', status: 'stopped' });
    }

    // ── Private: spawn & connect ───────────────────────────────────────────────

    private async _spawnAndConnect(): Promise<void> {
        const binary = this.opts.codexBinary ?? (await this._resolveBinary());
        this.port = await findAvailablePort(PORT_SCAN_RANGE_START, PORT_SCAN_RANGE_END);

        // Create capability token for auth
        const { token, tokenFile } = await createCapabilityToken();
        this.tokenFile = tokenFile;

        const listenUrl = `ws://127.0.0.1:${this.port}`;
        const args = [
            'app-server',
            '--listen', listenUrl,
            '--ws-auth', 'capability-token',
            '--ws-token-file', tokenFile,
        ];

        logger.debug(`[CodexAppServer] Spawning: ${binary} ${args.join(' ')}`);

        const env: NodeJS.ProcessEnv = {
            ...process.env,
            ...this.opts.env,
        };

        this.process = spawn(binary, args, {
            cwd: this.opts.cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout?.on('data', (chunk: Buffer) => {
            logger.debug(`[CodexAppServer] stdout: ${chunk.toString().trim()}`);
        });

        this.process.stderr?.on('data', (chunk: Buffer) => {
            logger.debug(`[CodexAppServer] stderr: ${chunk.toString().trim()}`);
        });

        this.process.once('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] Process exited: code=${code} signal=${signal}`);
            if (this.turnCompletionSignal) {
                this.turnCompletionSignal.reject(
                    new Error(`codex app-server exited unexpectedly (code=${code})`)
                );
                this.turnCompletionSignal = null;
            }
        });

        // Wait for the server port to be open
        await waitForServerReady(this.port, BINARY_START_TIMEOUT_MS);

        // Connect WebSocket with auth header
        await this._connectWebSocket(listenUrl, token);
    }

    private async _connectWebSocket(url: string, token: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`WebSocket connection timed out after ${WS_HANDSHAKE_TIMEOUT_MS}ms`));
            }, WS_HANDSHAKE_TIMEOUT_MS);

            const ws = new WebSocket(url, {
                headers: { Authorization: `Bearer ${token}` },
            });

            ws.once('open', () => {
                clearTimeout(timeout);
                logger.debug('[CodexAppServer] WebSocket connected');
                this.ws = ws;
                this._attachWsListeners();
                resolve();
            });

            ws.once('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    private _attachWsListeners(): void {
        if (!this.ws) return;

        this.ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString()) as WireMessage;
                this._handleWireMessage(msg);
            } catch (err) {
                logger.debug('[CodexAppServer] Failed to parse WS message:', err);
            }
        });

        this.ws.on('close', (code, reason) => {
            logger.debug(`[CodexAppServer] WebSocket closed: ${code} ${reason}`);
            if (this.turnCompletionSignal) {
                this.turnCompletionSignal.reject(
                    new Error(`WebSocket closed unexpectedly (code=${code})`)
                );
                this.turnCompletionSignal = null;
            }
        });

        this.ws.on('error', (err) => {
            logger.debug('[CodexAppServer] WebSocket error:', err);
        });
    }

    // ── Private: RPC ──────────────────────────────────────────────────────────

    private _request(method: string, params?: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('[CodexAppServer] WebSocket not connected'));
                return;
            }

            const id = randomUUID();
            const timeoutHandle = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`RPC request timed out: ${method} (${RPC_REQUEST_TIMEOUT_MS}ms)`));
            }, RPC_REQUEST_TIMEOUT_MS);

            this.pendingRequests.set(id, { resolve, reject, timeoutHandle });

            const msg: RpcRequest = { id, method, params };
            this.ws.send(JSON.stringify(msg));
        });
    }

    /** Send a response to a server-initiated request */
    private _respond(id: string, result: unknown): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const msg: RpcResponse = { id, result };
        this.ws.send(JSON.stringify(msg));
    }

    // ── Private: message dispatch ─────────────────────────────────────────────

    private _handleWireMessage(msg: WireMessage): void {
        // RPC response (has `result` or `error`, always has `id`)
        if ('id' in msg && ('result' in msg || 'error' in msg)) {
            const resp = msg as RpcResponse;
            const pending = this.pendingRequests.get(resp.id);
            if (pending) {
                clearTimeout(pending.timeoutHandle);
                this.pendingRequests.delete(resp.id);
                if (resp.error) {
                    pending.reject(new Error(`RPC error: ${resp.error.message}`));
                } else {
                    pending.resolve(resp.result);
                }
            }
            return;
        }

        const method = (msg as RpcNotification | RpcRequest).method;

        // Server request (server → client, has `id` and `method`)
        if ('id' in msg && 'method' in msg) {
            this._handleServerRequest(msg as RpcRequest);
            return;
        }

        // Notification
        if (method) {
            this._handleNotification(method, (msg as RpcNotification).params);
        }
    }

    private _handleServerRequest(req: RpcRequest): void {
        const { id, method, params } = req;

        switch (method) {
            case 'item/commandExecution/requestApproval': {
                const p = params as {
                    threadId: string;
                    turnId: string;
                    itemId: string;
                    approvalId?: string | null;
                    command?: string | null;
                    cwd?: string | null;
                    reason?: string | null;
                };

                const approvalRequestId = `exec:${p.itemId}:${p.approvalId ?? ''}`;
                this._emit({
                    type: 'permission-request',
                    id: approvalRequestId,
                    reason: p.reason ?? `Execute command: ${p.command ?? '(unknown)'}`,
                    payload: params,
                });

                if (this.opts.autoApprove) {
                    this._respond(id, { decision: 'acceptForSession' });
                } else {
                    // Default: auto-approve (happy CLI handles permission UI separately)
                    this._respond(id, { decision: 'accept' });
                }
                break;
            }

            case 'item/fileChange/requestApproval': {
                const p = params as {
                    threadId: string;
                    turnId: string;
                    itemId: string;
                    reason?: string | null;
                    grantRoot?: string | null;
                };

                const approvalRequestId = `file:${p.itemId}`;
                this._emit({
                    type: 'permission-request',
                    id: approvalRequestId,
                    reason: p.reason ?? `File change in ${p.grantRoot ?? '(unknown)'}`,
                    payload: params,
                });

                // Default: accept
                this._respond(id, { decision: 'accept' });
                break;
            }

            case 'item/permissions/requestApproval': {
                // Generic permissions approval — just accept
                this._respond(id, { decision: 'accept' });
                break;
            }

            default:
                // For unknown server requests, send a generic "not implemented" error
                logger.debug(`[CodexAppServer] Unhandled server request: ${method}`);
                this._respond(id, null);
        }
    }

    private _handleNotification(method: string, params: unknown): void {
        switch (method) {
            case 'item/agentMessage/delta': {
                const p = params as { threadId: string; turnId: string; itemId: string; delta: string };
                if (this.session) this.session.turnId = p.turnId;
                this.currentTextBuffer += p.delta;
                this._emit({ type: 'model-output', textDelta: p.delta });
                break;
            }

            case 'turn/completed': {
                logger.debug('[CodexAppServer] Turn completed');
                if (this.currentTextBuffer) {
                    this._emit({ type: 'model-output', fullText: this.currentTextBuffer });
                    this.currentTextBuffer = '';
                }
                this._emit({ type: 'status', status: 'idle' });
                if (this.turnCompletionSignal) {
                    this.turnCompletionSignal.resolve();
                    this.turnCompletionSignal = null;
                }
                if (this.session) this.session.isRunning = false;
                break;
            }

            case 'turn/started': {
                const p = params as { threadId: string; turnId: string };
                logger.debug(`[CodexAppServer] Turn started: ${p.turnId}`);
                if (this.session) this.session.turnId = p.turnId;
                break;
            }

            case 'item/started': {
                const p = params as { threadId: string; turnId: string; item?: { kind?: string } };
                logger.debug(`[CodexAppServer] Item started: ${p.item?.kind ?? 'unknown'}`);
                break;
            }

            case 'item/completed': {
                logger.debug('[CodexAppServer] Item completed');
                break;
            }

            case 'item/commandExecution/outputDelta': {
                const p = params as { threadId: string; output?: string };
                if (p.output) {
                    this._emit({ type: 'terminal-output', data: p.output });
                }
                break;
            }

            case 'item/fileChange/outputDelta': {
                const p = params as {
                    threadId: string;
                    itemId: string;
                    path?: string;
                    description?: string;
                };
                this._emit({
                    type: 'fs-edit',
                    description: p.description ?? 'File change',
                    path: p.path,
                });
                break;
            }

            case 'error': {
                const p = params as { message?: string; code?: string };
                logger.warn('[CodexAppServer] Server error notification:', p);
                this._emit({ type: 'status', status: 'error', detail: p.message ?? 'Unknown error' });
                if (this.turnCompletionSignal) {
                    this.turnCompletionSignal.reject(new Error(p.message ?? 'Server error'));
                    this.turnCompletionSignal = null;
                }
                break;
            }

            case 'thread/started':
            case 'thread/status/changed':
            case 'thread/tokenUsage/updated':
            case 'item/plan/delta':
            case 'item/reasoning/textDelta':
            case 'item/reasoning/summaryTextDelta':
            case 'item/reasoning/summaryPartAdded':
            case 'item/autoApprovalReview/started':
            case 'item/autoApprovalReview/completed':
            case 'rawResponseItem/completed':
            case 'turn/diff/updated':
            case 'turn/plan/updated':
            case 'hook/started':
            case 'hook/completed':
            case 'serverRequest/resolved':
            case 'model/rerouted':
            case 'deprecationNotice':
            case 'configWarning':
                // Intentionally ignored
                break;

            default:
                logger.debug(`[CodexAppServer] Unhandled notification: ${method}`);
        }
    }

    // ── Private: helpers ──────────────────────────────────────────────────────

    private _emit(msg: AgentMessage): void {
        for (const handler of this.messageHandlers) {
            try {
                handler(msg);
            } catch (err) {
                logger.debug('[CodexAppServer] Message handler threw:', err);
            }
        }
    }

    private _mapApprovalPolicy(
        policy: string
    ): 'Suggest' | 'AutoEdit' | 'FullAuto' | 'OnFailure' | 'Never' {
        switch (policy) {
            case 'auto-edit':
                return 'AutoEdit';
            case 'full-auto':
                return 'FullAuto';
            case 'on-failure':
                return 'OnFailure';
            case 'never':
                return 'Never';
            case 'suggest':
            default:
                return 'Suggest';
        }
    }

    private async _resolveBinary(): Promise<string> {
        const { execSync } = await import('node:child_process');
        try {
            execSync('codex-internal --version', { encoding: 'utf8', stdio: 'pipe' });
            return 'codex-internal';
        } catch {
            return 'codex';
        }
    }
}
