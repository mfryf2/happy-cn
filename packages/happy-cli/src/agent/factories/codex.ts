/**
 * Codex ACP Backend - Codex CLI agent via ACP
 *
 * This module provides a factory function for creating a Codex ACP backend
 * that communicates using the Agent Client Protocol (ACP).
 *
 * The internal Codex CLI (`codex`) is a wrapper around OpenAI Codex that supports
 * the `--acp` flag for ACP mode (similar to Gemini's `--experimental-acp`).
 *
 * @module factories/codex
 */

import { execSync } from 'node:child_process';
import { AcpBackend, type AcpBackendOptions, type AcpPermissionHandler } from '../acp/AcpBackend';
import type { AgentBackend, McpServerConfig, AgentFactoryOptions } from '../core';
import { agentRegistry } from '../core';
import { codexTransport } from '../transport';
import { logger } from '@/ui/logger';

/** Environment variable for Codex / OpenAI API key */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';

/** Environment variable for overriding the Codex model */
export const CODEX_MODEL_ENV = 'CODEX_MODEL';

/** Default Codex model */
export const DEFAULT_CODEX_MODEL = 'codex-1';

/**
 * Options for creating a Codex ACP backend.
 */
export interface CodexBackendOptions extends AgentFactoryOptions {
    /** API key for OpenAI/Codex (defaults to OPENAI_API_KEY env var) */
    apiKey?: string;

    /** Model to use.
     *  If undefined, uses CODEX_MODEL env var or the default model.
     *  If explicitly set to null, uses the default model (skips env var). */
    model?: string | null;

    /** MCP servers to make available to the agent */
    mcpServers?: Record<string, McpServerConfig>;

    /** Optional permission handler for tool approval */
    permissionHandler?: AcpPermissionHandler;
}

/**
 * Result of creating a Codex ACP backend.
 */
export interface CodexBackendResult {
    /** The created AgentBackend instance */
    backend: AgentBackend;
    /** The resolved model that will be used */
    model: string;
    /** Source of the model selection for logging */
    modelSource: 'explicit' | 'env-var' | 'default';
}

/**
 * Resolve the codex command to use.
 * Prefer `codex-internal` if available, fallback to `codex`.
 */
function resolveCodexCommand(): string {
    try {
        execSync('codex-internal --version', { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
        return 'codex-internal';
    } catch {
        return 'codex';
    }
}

/**
 * Determine the model to use.
 *
 * Priority: explicit option > CODEX_MODEL env var > default
 * If options.model is null, skip env var and use default.
 */
function resolveCodexModel(model: string | null | undefined): {
    model: string;
    modelSource: 'explicit' | 'env-var' | 'default';
} {
    if (model != null && model !== '') {
        return { model, modelSource: 'explicit' };
    }

    if (model !== null) {
        // model is undefined — check env var
        const envModel = process.env[CODEX_MODEL_ENV];
        if (envModel) {
            return { model: envModel, modelSource: 'env-var' };
        }
    }

    return { model: DEFAULT_CODEX_MODEL, modelSource: 'default' };
}

/**
 * Create a Codex ACP backend.
 *
 * The Codex CLI must be installed and available in PATH.
 * Uses the `--acp` flag to enable ACP mode.
 *
 * @param options - Configuration options
 * @returns CodexBackendResult with backend and resolved model
 */
export function createCodexBackend(options: CodexBackendOptions): CodexBackendResult {
    // Resolve API key: explicit option > OPENAI_API_KEY env var
    const apiKey = options.apiKey || process.env[OPENAI_API_KEY_ENV];

    if (!apiKey) {
        logger.warn(
            `[Codex] No API key found. Set the ${OPENAI_API_KEY_ENV} environment variable or use 'happy connect codex' to authenticate.`
        );
    }

    // Command to run — prefer `codex-internal` if available
    const codexCommand = resolveCodexCommand();

    // Resolve model
    const { model, modelSource } = resolveCodexModel(options.model);

    // Build args — use `--acp` flag for ACP mode
    // Model is passed via CODEX_MODEL env var to avoid stdout conflicts with ACP protocol
    const codexArgs = ['--acp'];

    const backendOptions: AcpBackendOptions = {
        agentName: 'codex',
        cwd: options.cwd,
        command: codexCommand,
        args: codexArgs,
        env: {
            ...options.env,
            ...(apiKey ? { [OPENAI_API_KEY_ENV]: apiKey } : {}),
            // Pass model via env var
            [CODEX_MODEL_ENV]: model,
            // Suppress debug output to avoid stdout pollution
            NODE_ENV: 'production',
            DEBUG: '',
        },
        mcpServers: options.mcpServers,
        permissionHandler: options.permissionHandler,
        transportHandler: codexTransport,
        // Auto-approve change_title calls when the prompt asks to change the title
        hasChangeTitleInstruction: (prompt: string) => {
            const lower = prompt.toLowerCase();
            return (
                lower.includes('change_title') ||
                lower.includes('change title') ||
                lower.includes('set title') ||
                lower.includes('mcp__happy__change_title')
            );
        },
    };

    logger.debug('[Codex] Creating ACP backend with options:', {
        cwd: backendOptions.cwd,
        command: backendOptions.command,
        args: backendOptions.args,
        hasApiKey: !!apiKey,
        model,
        modelSource,
        mcpServerCount: options.mcpServers ? Object.keys(options.mcpServers).length : 0,
    });

    return {
        backend: new AcpBackend(backendOptions),
        model,
        modelSource,
    };
}

/**
 * Register Codex ACP backend with the global agent registry.
 *
 * Call this during application initialization to make the Codex ACP agent available.
 */
export function registerCodexAcpAgent(): void {
    agentRegistry.register('codex-acp', (opts) => createCodexBackend(opts).backend);
    logger.debug('[Codex] Registered codex-acp with agent registry');
}
