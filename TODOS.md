# TODOS

Deferred work captured during engineering reviews and planning sessions.
Format: each TODO has context, rationale, and a clear starting point.

---

## [IMG-01] Strip EXIF from original images before storage

**Status: VERIFIED — Action Required**

**Verification result (2026-04-03):**
- `processImage.ts`：Sharp 无 `.withMetadata()`，缩略图路径 EXIF 安全 ✅
- `uploadImage.ts`：原始图片以 `src: Buffer` 直接存入 S3/本地，**未经任何 Sharp 处理**，EXIF 随原始图片保存 ⚠️

**What:** 在 `uploadImage.ts` 的存储路径上，调用 `sharp(src).toBuffer()` 剥除 EXIF 后再写入 S3/本地文件系统。

**Why:** 移动端截图可能包含 GPS 坐标、设备型号、时间戳。目前 `processImage.ts` 只生成缩略图，原始 buffer 直接存储，EXIF 完整保留在服务器。

**Where to start:** 修改 `packages/happy-server/sources/storage/uploadImage.ts`，在 `putLocalFile` / `s3client.putObject` 之前加一行 `const strippedSrc = await sharp(src).toBuffer();`，改用 `strippedSrc` 存储。

**Depends on / blocked by:** 需在实现 POST /v3/upload/image endpoint 之前完成。

---

## [IMG-02] ~~Decide: URL TTL vs re-sign strategy~~ — RESOLVED, NON-ISSUE

**Status: RESOLVED (2026-04-03) — 原设计假设有误，无需处理**

**Verification result:** 读取 `uploadImage.ts` 发现 `resolveImageUrl()` 生成的是**永久公开 URL**（`https://${s3host}/${s3bucket}/${path}`），完全没有签名机制和 TTL。"1小时签名URL vs 7天存储TTL缺口"的设计假设是错的。

**实际情况：** URL 永不过期，CLI 下载图片无需 JWT 认证，直接 GET 即可。图片为公开可访问（与 S3 bucket 的权限设置一致）。

**遗留决策：** 是否需要将图片 URL 改为需要认证访问（隐私保护）。目前行为与其他已上传文件一致，暂不需要改变。

---

## [IMG-03] ~~Verify CLI JWT availability~~ — RESOLVED ✅

**Status: RESOLVED (2026-04-03)**

**Verification result:** 读取 `packages/happy-cli/src/ui/auth.ts` 确认：
- `Credentials` 接口包含 `token: string` 字段
- `waitForAuthentication()` 在 auth 流程中从服务器响应提取 JWT 并通过 `writeCredentialsLegacy` 持久化存储
- CLI 确实持有可用于 HTTP 请求的 JWT

**实际情况：** 因 [IMG-02] 发现 URL 是公开可访问的，CLI 下载图片无需认证，直接 GET 图片 URL 即可。JWT 可备用，但图片下载路径不需要它。
