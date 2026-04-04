# 快速参考指南 - 消息输入和图片上传

## 📁 相关文件速查表

### 🎯 必读核心文件

| 文件 | 路径 | 核心功能 | 优先级 |
|------|------|---------|--------|
| **AgentInput.tsx** | `sources/components/AgentInput.tsx` | 主输入框、图片上传、粘贴处理 | ⭐⭐⭐⭐⭐ |
| **MultiTextInput.web.tsx** | `sources/components/MultiTextInput.web.tsx` | Web 文本输入、键盘处理 | ⭐⭐⭐⭐ |
| **apiUpload.ts** | `sources/sync/apiUpload.ts` | 图片 API 接口 | ⭐⭐⭐ |
| **sync.ts** | `sources/sync/sync.ts` | 消息发送（行 520-599） | ⭐⭐⭐⭐ |
| **SessionView.tsx** | `sources/-session/SessionView.tsx` | 会话页面集成（行 366-374） | ⭐⭐⭐ |

---

## 🔑 关键代码位置速查

### 📸 图片上传流程

```
AgentInput.tsx
├── 图片选择入口
│   └── doPickImage (行 552-607)
│       ├── Web: document.createElement('input') (行 553-593)
│       └── Native: ImagePicker.launchImageLibraryAsync (行 594-606)
├── 数据上传
│   └── uploadImageData (行 535-547)
│       └── apiUpload.uploadImage()
└── 预览和管理
    ├── pendingImages 状态 (行 390-394)
    └── 图片列表渲染 (行 1124-1175)
```

### 📋 粘贴处理

**文件**: AgentInput.tsx，行 612-640
```typescript
// Web 平台粘贴监听
window.addEventListener('paste', handlePaste)
// 检测 item.type.startsWith('image/')
// 阻止默认行为: event.preventDefault()
// 转 base64 并上传
```

### 📤 消息发送

**文件**: SessionView.tsx，行 366-374
```typescript
onSendWithImages((images, text) => {
    sync.sendMessageWithImages(sessionId, images, text)
})
```

**Sync 实现**: sync.ts，行 520-599
- 创建 contentBlocks 数组（文本 + 图片）
- 设置 sentFrom 标识平台
- 加密并发送

---

## 🛠️ 常见需求和代码位置

### Q1: 如何添加新的图片格式支持？

**文件**: AgentInput.tsx，行 536-538
```typescript
// 修改这里的 MIME 类型列表
const mimeType = (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(rawMime)
    ? rawMime
    : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
```

**同时更新**:
1. Web 文件选择: 行 557 `input.accept`
2. API 类型: apiUpload.ts 行 20

### Q2: 如何修改图片预览大小？

**文件**: AgentInput.tsx，行 1130
```typescript
<Image
    source={{ uri: img.uri }}
    style={{ width: 64, height: 64, borderRadius: 8 }}  // ← 修改这里
    contentFit="cover"
/>
```

### Q3: 如何禁用粘贴图片？

**文件**: AgentInput.tsx，行 612-613
```typescript
React.useEffect(() => {
    if (Platform.OS !== 'web') return;  // ← 改为 return;
    // 粘贴处理代码...
}, [uploadImageData]);
```

### Q4: 如何改变发送前的验证逻辑？

**文件**: AgentInput.tsx，行 396-398
```typescript
const canPressSendButton = !props.isSending
    && !props.isSendDisabled
    && (isSendBlocked ? hasText : (hasText || !!props.onMicPress || pendingImages.length > 0));
    // ↑ 修改条件
```

### Q5: 如何获取上传图片的元数据？

**返回值**: apiUpload.ts，UploadImageResult
```typescript
{
    url: string,        // 可访问的 URL
    width: number,      // 图片宽度
    height: number      // 图片高度
}
```

---

## 📊 数据流图

### 完整上传流程

```
用户交互
    ↓
┌─────────────────────────────────────┐
│ AgentInput 组件                      │
├─────────────────────────────────────┤
│ • pendingImages 状态                │
│ • 粘贴事件监听 (Web only)            │
│ • 文件选择对话框                    │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ uploadImageData()                   │
├─────────────────────────────────────┤
│ • 验证 MIME 类型                    │
│ • 获取认证凭据                      │
│ • 调用 API                          │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ apiUpload.uploadImage()             │
├─────────────────────────────────────┤
│ • POST /v3/upload/image             │
│ • 返回 URL + 尺寸                   │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ pendingImages 更新                  │
├─────────────────────────────────────┤
│ • 显示预览                          │
│ • 启用删除按钮                      │
│ • 显示 "添加更多" 按钮              │
└─────────────────────────────────────┘
    ↓
用户点击发送
    ↓
┌─────────────────────────────────────┐
│ onSendWithImages()                  │
├─────────────────────────────────────┤
│ • 映射图片数据                      │
│ • 调用 sync.sendMessageWithImages()│
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│ sync.sendMessageWithImages()        │
├─────────────────────────────────────┤
│ • 创建 contentBlocks 数组           │
│ • 混合文本和图片                    │
│ • 设置 sentFrom 平台标识            │
│ • 加密消息                          │
│ • 发送到服务器                      │
└─────────────────────────────────────┘
    ↓
✅ 消息已发送
```

---

## 🎨 样式和 UI 相关

### 容器和布局

**输入框容器**: AgentInput.tsx，行 86-111
- `unifiedPanel`: 主容器背景
- `inputContainer`: 输入行容器
- `actionButtonsContainer`: 按钮容器

### 颜色和主题

所有颜色使用 Unistyles 主题:
```typescript
theme.colors.input.background
theme.colors.input.text
theme.colors.divider
theme.colors.surfacePressed
```

---

## 🔍 调试技巧

### 1. 检查图片是否上传成功

**位置**: AgentInput.tsx，行 543-546
```typescript
const uploadResult = await uploadImage(credentials, base64, mimeType);
console.log('上传结果:', uploadResult);  // ← 添加日志
```

### 2. 监听粘贴事件

**位置**: AgentInput.tsx，行 615
```typescript
const handlePaste = (event: ClipboardEvent) => {
    console.log('粘贴事件捕获:', event.clipboardData?.items);  // ← 添加日志
    // ...
};
```

### 3. 查看待上传图片状态

```typescript
// React DevTools 中检查 pendingImages 状态
console.log('待上传图片:', pendingImages);
```

### 4. 验证消息格式

**位置**: sync.ts，行 558-574
```typescript
console.log('内容块:', contentBlocks);  // ← 查看混合内容
```

---

## ⚠️ 常见问题和解决方案

| 问题 | 原因 | 解决方案 |
|------|------|---------|
| 粘贴无效 | 仅在 Web 平台有效 | 检查 `Platform.OS === 'web'` |
| 图片无法删除 | 状态更新失败 | 检查 `setPendingImages` 回调 |
| 上传 API 失败 | 认证问题 | 检查 `TokenStorage.getCredentials()` |
| MIME 类型错误 | 文件类型不支持 | 查看支持的格式列表 |
| 发送按钮不可用 | 条件检查 | 检查 `canPressSendButton` 逻辑 |

---

## 📚 关键 Hook 和工具

### useHappyAction
**文件**: sources/hooks/useHappyAction.ts
**用途**: 包装异步操作，自动处理错误和加载状态
```typescript
const [isLoading, doAction] = useHappyAction(async () => {
    // 异步操作
});
```

### useDraft
**用途**: 自动保存消息草稿
**位置**: sources/hooks/useDraft.ts

---

## 🌐 Web 平台特定代码

### MultiTextInput.web.tsx 特性

1. **组合输入检测** (行 68-69)
   ```typescript
   const isComposing = e.nativeEvent.isComposing || e.keyCode === 229;
   ```

2. **选择追踪** (行 117-120)
   ```typescript
   const selection = { 
       start: e.target.selectionStart, 
       end: e.target.selectionEnd 
   };
   ```

3. **文件选择** (AgentInput.tsx，行 553-593)
   - 动态创建 input 元素
   - 监听窗口焦点（检测取消）

---

## ✅ 开发检查清单

- [ ] 修改后运行 `yarn typecheck`
- [ ] 测试 Web 平台粘贴功能
- [ ] 测试 iOS/Android 文件选择
- [ ] 检查图片预览渲染
- [ ] 验证消息发送流程
- [ ] 检查错误处理
- [ ] 测试多图片上传
- [ ] 检查内存泄漏（事件监听清理）

---

## 🔗 相关文档链接

- CLAUDE.md - 项目开发指南
- 主组件分析 - COMPONENT_ANALYSIS.md
