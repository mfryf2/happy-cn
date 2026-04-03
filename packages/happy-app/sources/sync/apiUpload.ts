import { AuthCredentials } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

export interface UploadImageResult {
    url: string;
    width: number;
    height: number;
}

/**
 * 上传图片到服务器
 * @param credentials 用户认证凭据
 * @param data base64 编码的图片数据
 * @param mimeType 图片 MIME 类型
 * @returns 上传后的公共 URL、宽度、高度
 */
export async function uploadImage(
    credentials: AuthCredentials,
    data: string,
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
): Promise<UploadImageResult> {
    const API_ENDPOINT = getServerUrl();
    const response = await fetch(`${API_ENDPOINT}/v3/upload/image`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data, mimeType }),
    });
    if (!response.ok) {
        throw new Error(`Upload failed: ${response.status}`);
    }
    return response.json() as Promise<UploadImageResult>;
}
