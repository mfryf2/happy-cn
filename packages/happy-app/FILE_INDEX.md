# 文件索引 - 消息输入和图片上传功能

## 📋 核心组件文件

### 1. AgentInput.tsx ⭐⭐⭐⭐⭐
**路径**: `sources/components/AgentInput.tsx`  
**行数**: 1432  
**重点代码段**:

| 功能 | 行号范围 | 描述 |
|------|---------|------|
| 导入和类型定义 | 1-81 | 导入依赖，定义 Props 接口 |
| 待上传图片状态 | 390-394 | `pendingImages` 状态管理 |
| 发送按钮条件 | 396-398 | `canPressSendButton` 逻辑 |
| 图片数据上传 | 535-547 | `uploadImageData` 函数 |
| 图片选择器 | 552-607 | `doPickImage` - Web/Native 实现 |
| **粘贴事件处理** | **612-640** | **⭐ Web 平台核心** |
| 键盘处理 | 643-703 | 自动完成和快捷键 |
| 图片预览 | 1124-1175 | 预览列表和删除按钮 |
| 输入区域 | 1177-1189 | MultiTextInput 集成 |

### 2. MultiTextInput.web.tsx ⭐⭐⭐⭐
**路径**: `sources/components/MultiTextInput.web.tsx`  
**行数**: 213  
**重点代码段**:

| 功能 | 行号范围 | 描述 |
|------|---------|------|
| 类型和接口 | 1-46 | KeyPressEvent, TextInputState, Handle |
| 键盘处理 | 65-113 | `handleKeyDown` - 组合输入检测 |
| 文本变化 | 115-130 | `handleChange` 和选择同步 |
| 选择变化 | 132-145 | `handleSelect` - 光标位置追踪 |
| 命令式 API | 148-175 | `setTextAndSelection` 实现 |
| 渲染 | 177-210 | TextareaAutosize 组件 |

### 3. MultiTextInput.tsx
**路径**: `sources/components/MultiTextInput.tsx`  
**行数**: 150  
**说明**: 原生平台实现（iOS/Android）

---

## 🔌 API 和同步文件

### 4. apiUpload.ts ⭐⭐⭐
**路径**: `sources/sync/apiUpload.ts`  
**行数**: 36

```typescript
export interface UploadImageResult {
    url: string;          // 完整的可访问 URL
    width: number;        // 图片宽度
    height: number;       // 图片高度
}

export async function uploadImage(
    credentials: AuthCredentials,
    data: string,          // base64 编码的图片数据
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'
): Promise<UploadImageResult>
```

**关键细节**:
- 发送到: `POST /v3/upload/image`
- 认证: Bearer token in headers
- 传输格式: JSON
- 接受的格式: JPEG, PNG, WebP, GIF

### 5. sync.ts ⭐⭐⭐⭐
**路径**: `sources/sync/sync.ts`  
**关键方法**: 行 520-599

**sendMessageWithImages()** 方法:
- 参数: `sessionId`, `images[]`, `text?`
- 功能: 创建混合文本和图片的消息
- 过程:
  1. 获取加密对象
  2. 确定 sentFrom 平台
  3. 创建 contentBlocks 数组
  4. 加密消息
  5. 发送到服务器

---

## 📱 页面和集成文件

### 6. SessionView.tsx ⭐⭐⭐
**路径**: `sources/-session/SessionView.tsx`  
**重点代码段**:

| 功能 | 行号范围 | 描述 |
|------|---------|------|
| AgentInput 集成 | 339-397 | 主输入框的创建和配置 |
| onSendWithImages 回调 | 366-374 | 处理带图片的消息发送 |
| 消息草稿 | 244 | useDraft 集成 |

**onSendWithImages 实现** (行 366-374):
```typescript
onSendWithImages={(images, text) => {
    const textToSend = text || message.trim() || undefined;
    sync.sendMessageWithImages(
        sessionId, 
        images.map(img => ({ url: img.uri, width: img.width, height: img.height })), 
        textToSend
    );
    if (message.trim()) {
        setMessage('');
        clearDraft();
    }
    trackMessageSent();
}}
```

---

## 🎯 自动完成和工具文件

### 7. autocomplete/ 文件夹
**路径**: `sources/components/autocomplete/`

| 文件 | 功能 |
|------|------|
| `useActiveWord.ts` | 检测 @ / 前缀的活动词 |
| `useActiveSuggestions.ts` | 管理建议列表和选择状态 |
| `applySuggestion.ts` | 应用建议到文本 |
| `suggestions.ts` | 获取建议列表 |

### 8. useHappyAction.ts
**路径**: `sources/hooks/useHappyAction.ts`

用于包装异步操作（如图片上传）:
```typescript
const [isPickingImage, doPickImage] = useHappyAction(async () => {
    // 图片选择逻辑
});
```

---

## 🌐 Web 平台特定文件

| 文件 | 功能 |
|------|------|
| `MultiTextInput.web.tsx` | 文本输入 |
| `Shaker.web.tsx` | 震动反馈 (模拟) |
| `haptics.web.ts` | 触觉 API |
| `PlusPlus.web.tsx` | 特殊 UI |
| `RealtimeProvider.web.tsx` | 实时通信 |
| `RealtimeVoiceSession.web.tsx` | 语音会话 |
| `SessionActionsNativeMenu.web.tsx` | 菜单 |
| `revenueCat/revenueCat.web.ts` | 购买系统 |
| `libsodium.lib.web.ts` | 加密库 |
| `loadSkia.web.ts` | 图形库 |

---

## 🔐 身份验证和存储

### TokenStorage
**路径**: `sources/auth/tokenStorage.ts`

```typescript
// 在 uploadImageData 中使用
const credentials = await TokenStorage.getCredentials();
```

---

## 🎨 样式和主题相关

### UnistyleSheet 配置
**位置**: AgentInput.tsx，行 85-319

关键样式:
- `unifiedPanel` (86-102) - 主容器
- `inputContainer` (103-111) - 输入行
- `actionButtonsContainer` (229-234) - 按钮容器
- `imagePickerButton` (310-318) - 图片选择按钮

### 主题颜色
```typescript
theme.colors.input.background
theme.colors.input.text
theme.colors.divider
theme.colors.surfacePressed
theme.colors.button.secondary.tint
```

---

## 📊 类型定义文件

### 核心类型
**位置**: `sources/sync/storageTypes.ts` (消息相关类型)

### 消息格式
```typescript
type ContentBlock = 
    | { type: 'text'; text: string }
    | { type: 'image_url'; url: string; width?: number; height?: number }
```

---

## 🔍 搜索快速指令

### 查找特定功能

```bash
# 找粘贴处理
grep -n "handlePaste" sources/components/AgentInput.tsx

# 找图片上传
grep -n "uploadImage" sources/components/AgentInput.tsx
grep -n "uploadImage" sources/sync/apiUpload.ts

# 找消息发送
grep -n "sendMessageWithImages" sources/sync/sync.ts

# 找所有 Web 特定文件
find sources -name "*.web.tsx" -o -name "*.web.ts"

# 找所有图片相关代码
grep -r "image\|Image" sources/components/*.tsx | grep -v node_modules
```

---

## 📚 文档链接

| 文档 | 用途 |
|------|------|
| `CLAUDE.md` | 项目开发指南 |
| `COMPONENT_ANALYSIS.md` | 详细的组件分析 |
| `COMPONENT_QUICK_REFERENCE.md` | 快速参考和 FAQ |
| `FILE_INDEX.md` | 本文件 |

---

## ⏱️ 估计学习时间

| 内容 | 时间 |
|------|------|
| 快速浏览此索引 | 5 分钟 |
| 读 QUICK_REFERENCE | 15 分钟 |
| 研究 AgentInput 核心功能 | 30 分钟 |
| 研究完整流程 | 1-2 小时 |
| 修改和测试功能 | 1-3 小时 |

---

## 🚀 快速导航

### 我想...
- **添加新的图片格式**: 见 `AgentInput.tsx` 行 536-538
- **修改图片预览大小**: 见 `AgentInput.tsx` 行 1130
- **禁用粘贴功能**: 见 `AgentInput.tsx` 行 612-613
- **修改上传 API**: 见 `apiUpload.ts` 行 23
- **改变消息格式**: 见 `sync.ts` 行 558-586
- **添加新键盘快捷键**: 见 `AgentInput.tsx` 行 643-703
- **修改图片验证**: 见 `AgentInput.tsx` 行 536-547

---

## 🔗 关键函数映射

```
用户粘贴/选择图片
    ↓
AgentInput.doPickImage() [行 552-607]
    ↓
    Web: input.createElement() [行 553-593]
    Native: ImagePicker.launchImageLibraryAsync [行 594-606]
    ↓
AgentInput.uploadImageData() [行 535-547]
    ↓
apiUpload.uploadImage() [apiUpload.ts]
    ↓
POST /v3/upload/image
    ↓
UploadImageResult { url, width, height }
    ↓
AgentInput.setPendingImages() [行 542-546]
    ↓
用户点击发送
    ↓
SessionView.onSendWithImages() [行 366-374]
    ↓
sync.sendMessageWithImages() [sync.ts 行 520]
    ↓
创建 contentBlocks [行 558-574]
    ↓
加密并发送
    ↓
✅ 完成
```

---

## ✨ 关键特性总结

✅ **多平台支持**: Web、iOS、Android、macOS  
✅ **粘贴上传**: Web 平台独有功能  
✅ **文件选择**: 所有平台支持  
✅ **预览管理**: 上传前预览和删除  
✅ **混合消息**: 文本和图片组合  
✅ **端到端加密**: 所有消息加密  
✅ **错误处理**: 自动重试机制  
✅ **性能优化**: 草稿保存和缓存  

