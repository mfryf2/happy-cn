import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { putLocalFile, getPublicUrl, isLocalStorage, s3client, s3bucket } from "@/storage/files";
import * as privacyKit from "privacy-kit";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";

/** 图片上传的最大原始大小：5MB */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 允许的 MIME 类型及对应扩展名 */
const ALLOWED_MIME: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
};

/**
 * 图片上传路由
 * POST /v3/upload/image — 接收 base64 编码的图片，剥除所有元数据（EXIF / IPTC / XMP）后上传到存储并返回公共 URL。
 * 客户端负责 E2E 加密消息体中写入该 URL；CLI 通过 URL 下载图片后转 base64 传给 Claude SDK。
 */
export function uploadRoutes(app: Fastify) {
    app.post('/v3/upload/image', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                /** base64 编码的图片原始数据 */
                data: z.string(),
                /** 图片 MIME 类型 */
                mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
            }),
            response: {
                200: z.object({
                    url: z.string(),
                    width: z.number(),
                    height: z.number(),
                }),
                400: z.object({ error: z.string() }),
                500: z.object({ error: z.string() }),
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { data, mimeType } = request.body;

        // 解码 base64
        let imageBuffer: Buffer;
        try {
            const decoded = privacyKit.decodeBase64(data);
            imageBuffer = Buffer.from(decoded);
        } catch {
            return reply.code(400).send({ error: 'Invalid base64 data' });
        }

        // 检查文件大小
        if (imageBuffer.length > MAX_IMAGE_BYTES) {
            return reply.code(400).send({ error: `Image too large: max ${MAX_IMAGE_BYTES / 1024 / 1024}MB` });
        }

        // 使用 sharp 剥除所有元数据（EXIF / IPTC / XMP）并获取尺寸
        // sharp() 默认行为：不调用 .withMetadata() 时会剥除全部元数据
        let processedBuffer: Buffer;
        let width: number;
        let height: number;
        try {
            const image = sharp(imageBuffer);
            const metadata = await sharp(imageBuffer).metadata();
            width = metadata.width ?? 0;
            height = metadata.height ?? 0;

            // 统一输出为目标格式（去除 EXIF）
            if (mimeType === 'image/jpeg') {
                processedBuffer = await image.jpeg().toBuffer();
            } else if (mimeType === 'image/png') {
                processedBuffer = await image.png().toBuffer();
            } else if (mimeType === 'image/webp') {
                processedBuffer = await image.webp().toBuffer();
            } else {
                // gif 直接透传（sharp 对 gif 动画支持有限，直接保留原始数据）
                processedBuffer = imageBuffer;
            }
        } catch (err) {
            log({ module: 'upload', level: 'error', userId }, `Failed to process image: ${err}`);
            return reply.code(400).send({ error: 'Invalid or unsupported image data' });
        }

        // 生成存储路径
        const ext = ALLOWED_MIME[mimeType] ?? 'bin';
        const filePath = `images/${uuidv4()}.${ext}`;

        // 上传到存储
        try {
            if (isLocalStorage()) {
                await putLocalFile(filePath, processedBuffer);
            } else {
                await s3client.putObject(
                    s3bucket,
                    filePath,
                    processedBuffer,
                    processedBuffer.length,
                    { 'Content-Type': mimeType }
                );
            }
        } catch (err) {
            log({ module: 'upload', level: 'error', userId }, `Failed to store image: ${err}`);
            return reply.code(500).send({ error: 'Failed to store image' });
        }

        const url = getPublicUrl(filePath);
        log({ module: 'upload', userId, filePath, size: processedBuffer.length }, 'Image uploaded');

        return reply.send({ url, width, height });
    });
}
