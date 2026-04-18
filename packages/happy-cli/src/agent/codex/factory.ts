/**
 * Codex app-server factory functions
 *
 * Creates a CodexAppServerBackend that communicates with the native Codex binary
 * via the `codex app-server` WebSocket RPC protocol.
 */

import { CodexAppServerBackend, type CodexAppServerOptions } from './CodexAppServerBackend';
import type { AgentBackend, AgentFactoryOptions, McpServerConfig } from '../core';
import { agentRegistry } from '../core';
import { logger } from '@/ui/logger';

const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';
const CODEX_MODEL_ENV = 'CODEX_MODEL';
const DEFAULT_CODEX_MODEL = 'codex-1';

export interface CodexAppServerFactoryOptions extends AgentFactoryOptions {
    /** OpenAI / Codex API key */
    apiKey?: string;
    /** Model to use — defaults to CODEX_MODEL env or 'codex-1' */
    model?: string | null;
    /** Approval policy */
    approvalPolicy?: CodexAppServerOptions['approvalPolicy'];
    /** Auto-approve all tool/exec/file requests */
    autoApprove?: boolean;
    /** MCP servers to make available to the agent */
    mcpServers?: Record<string, McpServerConfig>;
}

function resolveModel(model: string | null | undefined): string {
    if (model != null && model !== '') return model;
    if (model !== null) {
        const envModel = process.env[CODEX_MODEL_ENV];
        if (envModel) return envModel;
    }
    return DEFAULT_CODEX_MODEL;
}

/**
 * Create a CodexAppServerBackend for the given options.
 */
export function createCodexAppServerBackend(
    options: CodexAppServerFactoryOptions
): AgentBackend {
    const apiKey = options.apiKey ?? process.env[OPENAI_API_KEY_ENV];
    if (!apiKey) {
        logger.warn(
            `[Codex] No API key found. Set ${OPENAI_API_KEY_ENV} or authenticate via 'happy connect codex'.`
        );
    }

    const model = resolveModel(options.model);

    const backendOpts: CodexAppServerOptions = {
        agentName: 'codex',
        cwd: options.cwd,
        model,
        approvalPolicy: options.approvalPolicy ?? 'suggest',
        autoApprove: options.autoApprove ?? false,
        env: {
            ...options.env,
            ...(apiKey ? { [OPENAI_API_KEY_ENV]: apiKey } : {}),
        },
        mcpServers: options.mcpServers,
    };

    logger.debug('[Codex] Creating app-server backend:', {
        cwd: backendOpts.cwd,
        model,
        approvalPolicy: backendOpts.approvalPolicy,
        hasApiKey: !!apiKey,
    });

    return new CodexAppServerBackend(backendOpts);
}

/**
 * Register the Codex app-server backend with the global agent registry.
 * Call this during application initialization.
 */
export function registerCodexAppServerAgent(): void {
    agentRegistry.register('codex', (opts) =>
        createCodexAppServerBackend(opts as CodexAppServerFactoryOptions)
    );
    logger.debug('[Codex] Registered codex (app-server) with agent registry');
}

