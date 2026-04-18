/**
 * Codex Transport Handler
 *
 * OpenAI Codex CLI-specific implementation of TransportHandler.
 * Handles:
 * - Standard init timeout (Codex CLI starts relatively quickly)
 * - Stdout filtering (removes non-JSON debug lines if needed)
 * - Stderr parsing (detects API key errors, rate limits, quota errors)
 * - Tool name patterns (shell, file operations, etc.)
 *
 * @module CodexTransport
 */

import type {
  TransportHandler,
  ToolPattern,
  StderrContext,
  StderrResult,
  ToolNameContext,
} from '../TransportHandler';
import type { AgentMessage } from '../../core';
import { logger } from '@/ui/logger';

/**
 * Codex-specific timeout values (in milliseconds)
 */
export const CODEX_TIMEOUTS = {
  /** Codex CLI starts reasonably fast */
  init: 60_000,
  /** Standard tool call timeout */
  toolCall: 120_000,
  /** Shell/container tool calls can run for a long time */
  shell: 300_000,
  /** Idle detection after last message chunk */
  idle: 500,
} as const;

/**
 * Known tool name patterns for Codex CLI.
 * Codex uses tools like shell execution and file operations.
 */
const CODEX_TOOL_PATTERNS: ToolPattern[] = [
  {
    name: 'shell',
    patterns: ['shell', 'exec', 'run_command', 'run-command', 'execute'],
  },
  {
    name: 'change_title',
    patterns: ['change_title', 'change-title', 'mcp__happy__change_title'],
  },
];

/**
 * Codex CLI transport handler.
 *
 * Handles Codex-specific quirks:
 * - API key authentication errors
 * - Rate limit detection in stderr
 * - Tool name extraction
 */
export class CodexTransport implements TransportHandler {
  readonly agentName = 'codex';

  /**
   * Codex CLI init timeout — 60 seconds is sufficient for normal startup
   */
  getInitTimeout(): number {
    return CODEX_TIMEOUTS.init;
  }

  /**
   * Filter Codex CLI stdout output.
   *
   * Codex CLI may output non-JSON debug info to stdout that breaks ACP JSON-RPC parsing.
   * Only keep lines that are valid JSON objects/arrays.
   */
  filterStdoutLine(line: string): string | null {
    const trimmed = line.trim();

    // Empty lines - skip
    if (!trimmed) {
      return null;
    }

    // Must start with { or [ to be valid JSON-RPC
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return null;
    }

    // Validate it's actually parseable JSON and is an object (not a primitive)
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      return line;
    } catch {
      return null;
    }
  }

  /**
   * Handle Codex CLI stderr output.
   *
   * Detects:
   * - Missing/invalid API key errors — show user-friendly error
   * - Rate limit errors (429) — logged but not shown (CLI handles retries)
   * - Quota exceeded — show error to user
   * - Other errors — log for debugging
   */
  handleStderr(text: string, _context: StderrContext): StderrResult {
    const trimmed = text.trim();
    if (!trimmed) {
      return { message: null, suppress: true };
    }

    // Missing or invalid API key
    if (
      trimmed.includes('OPENAI_API_KEY') ||
      trimmed.includes('invalid_api_key') ||
      trimmed.includes('Incorrect API key') ||
      trimmed.includes('No API key') ||
      trimmed.includes('authentication')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Codex API key is missing or invalid. Set the OPENAI_API_KEY environment variable.',
      };
      return { message: errorMessage };
    }

    // Rate limit error (429) — Codex CLI may handle retries internally
    if (
      trimmed.includes('status 429') ||
      trimmed.includes('code":429') ||
      trimmed.includes('rate_limit_exceeded') ||
      trimmed.includes('Too Many Requests')
    ) {
      return {
        message: null,
        suppress: false, // Log for debugging but don't show to user
      };
    }

    // Quota exceeded
    if (
      trimmed.includes('insufficient_quota') ||
      trimmed.includes('quota exceeded') ||
      trimmed.includes('billing')
    ) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'OpenAI quota exceeded. Please check your billing and usage at platform.openai.com.',
      };
      return { message: errorMessage };
    }

    // Model not found
    if (trimmed.includes('model_not_found') || trimmed.includes('status 404')) {
      const errorMessage: AgentMessage = {
        type: 'status',
        status: 'error',
        detail: 'Codex model not found. Check that your API key has access to the requested model.',
      };
      return { message: errorMessage };
    }

    return { message: null };
  }

  /**
   * Codex-specific tool patterns
   */
  getToolPatterns(): ToolPattern[] {
    return CODEX_TOOL_PATTERNS;
  }

  /**
   * Check if tool is a long-running shell/container tool (needs extended timeout)
   */
  isInvestigationTool(toolCallId: string, toolKind?: string): boolean {
    const lowerId = toolCallId.toLowerCase();
    return (
      lowerId.includes('shell') ||
      lowerId.includes('container') ||
      (typeof toolKind === 'string' && (toolKind.includes('shell') || toolKind.includes('container')))
    );
  }

  /**
   * Get timeout for a tool call
   */
  getToolCallTimeout(toolCallId: string, toolKind?: string): number {
    if (this.isInvestigationTool(toolCallId, toolKind)) {
      return CODEX_TIMEOUTS.shell;
    }
    return CODEX_TIMEOUTS.toolCall;
  }

  /**
   * Get idle detection timeout
   */
  getIdleTimeout(): number {
    return CODEX_TIMEOUTS.idle;
  }

  /**
   * Extract tool name from toolCallId using Codex patterns.
   */
  extractToolNameFromId(toolCallId: string): string | null {
    const lowerId = toolCallId.toLowerCase();

    for (const toolPattern of CODEX_TOOL_PATTERNS) {
      for (const pattern of toolPattern.patterns) {
        if (lowerId.includes(pattern.toLowerCase())) {
          return toolPattern.name;
        }
      }
    }

    return null;
  }

  /**
   * Determine the real tool name from various sources.
   *
   * When Codex sends an ambiguous tool name, tries to determine the real name from:
   * 1. toolCallId patterns (most reliable)
   * 2. Returns original tool name as fallback
   */
  determineToolName(
    toolName: string,
    toolCallId: string,
    input: Record<string, unknown>,
    _context: ToolNameContext
  ): string {
    // If tool name is already known, return it
    if (toolName !== 'other' && toolName !== 'Unknown tool') {
      return toolName;
    }

    // 1. Check toolCallId for known tool names
    const idToolName = this.extractToolNameFromId(toolCallId);
    if (idToolName) {
      return idToolName;
    }

    // Log unknown patterns for future pattern additions
    if (toolName === 'other' || toolName === 'Unknown tool') {
      const inputKeys = input && typeof input === 'object' ? Object.keys(input) : [];
      logger.debug(
        `[CodexTransport] Unknown tool pattern - toolCallId: "${toolCallId}", ` +
        `toolName: "${toolName}", inputKeys: [${inputKeys.join(', ')}]. ` +
        `Consider adding a new pattern to CODEX_TOOL_PATTERNS if this tool appears frequently.`
      );
    }

    return toolName;
  }
}

/**
 * Singleton instance for convenience
 */
export const codexTransport = new CodexTransport();
