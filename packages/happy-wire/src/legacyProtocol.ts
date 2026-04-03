import * as z from 'zod';
import { MessageMetaSchema } from './messageMeta';

// Content block types for user messages
export const TextBlockSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

export const ImageUrlBlockSchema = z.object({
    type: z.literal('image_url'),
    url: z.string().url(),
});
export type ImageUrlBlock = z.infer<typeof ImageUrlBlockSchema>;

export const ContentBlockSchema = z.discriminatedUnion('type', [TextBlockSchema, ImageUrlBlockSchema]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

// Legacy single-object content format (old clients)
const LegacyContentObjectSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
});

export const UserMessageSchema = z.object({
    role: z.literal('user'),
    content: z.array(ContentBlockSchema),
    localKey: z.string().optional(),
    meta: MessageMetaSchema.optional(),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AgentMessageSchema = z.object({
    role: z.literal('agent'),
    content: z
        .object({
            type: z.string(),
        })
        .passthrough(),
    meta: MessageMetaSchema.optional(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const LegacyMessageContentSchema = z.discriminatedUnion('role', [UserMessageSchema, AgentMessageSchema]);
export type LegacyMessageContent = z.infer<typeof LegacyMessageContentSchema>;

/**
 * Normalize raw message content from old or new format to ContentBlock[].
 * Old format: { type: 'text', text: '...' } → [{ type: 'text', text: '...' }]
 * New format: [{ type: 'text', text: '...' }, ...] → passthrough unchanged
 */
export function normalizeContent(content: unknown): ContentBlock[] {
    if (Array.isArray(content)) {
        return z.array(ContentBlockSchema).parse(content);
    }
    // Legacy single object
    const legacy = LegacyContentObjectSchema.parse(content);
    return [{ type: 'text', text: legacy.text }];
}

/**
 * Extract plain text from a ContentBlock array or legacy string/object.
 * Returns undefined if there is no text block (e.g., image-only message).
 */
export function extractText(content: ContentBlock[]): string | undefined {
    const textBlock = content.find((b): b is TextBlock => b.type === 'text');
    return textBlock?.text;
}

/**
 * Extract plain text safely, returning empty string if no text block exists.
 * Use this when you need a non-nullable string (e.g., for downstream string ops).
 */
export function extractTextOrEmpty(content: ContentBlock[]): string {
    return extractText(content) ?? '';
}
