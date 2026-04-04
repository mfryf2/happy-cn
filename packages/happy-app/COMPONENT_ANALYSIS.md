# Happy App - 消息输入、图片上传相关组件分析

## 项目结构概览
- **项目路径**: `/Users/mengfanrong/Documents/src/happy-cn/packages/happy-app`
- **技术栈**: React Native + Expo + TypeScript
- **主要结构**:
  - `sources/components/` - 可复用组件
  - `sources/app/` - 路由和页面
  - `sources/sync/` - 实时同步引擎
  - `sources/hooks/` - 自定义 Hooks

---

## 1. 消息输入相关组件

### 1.1 AgentInput 组件（主要输入组件）
**文件路径**: `sources/components/AgentInput.tsx`
**行数**: 1432 行
**关键功能**:
- 统一的消息输入框 UI
- 支持多行文本输入
- 自动完成建议
- 权限模式选择
- 模型选择
- 语音输入按钮
- 图片上传和预览
- 粘贴事件处理（Web）

**核心特性**:
```typescript
interface AgentInputProps {
    value: string;
    onChangeText: (text: string) => void;
    onSend: () => void;
    onSendWithImages?: (images: Array<{ uri: string; width: number; height: number }>, text?: string) => void;
    onMicPress?: () => void;
    isMicActive?: boolean;
    // ... 其他属性
}
```

**关键代码片段** (行 389-407):
```typescript
// 待上传图片状态
const [pendingImages, setPendingImages] = React.useState<Array<{
    uri: string;
    width: number;
    height: number;
}>>([]);

// 检查发送按钮是否可点击
const canPressSendButton = !props.isSending
    && !props.isSendDisabled
    && (isSendBlocked ? hasText : (hasText || !!props.onMicPress || pendingImages.length > 0));
```

---

### 1.2 MultiTextInput 组件（跨平台文本输入）
**文件路径**: 
- 原生版: `sources/components/MultiTextInput.tsx` (150 行)
- Web 版: `sources/components/MultiTextInput.web.tsx` (213 行)

**原生实现 (MultiTextInput.tsx)**:
- 基于 React Native `TextInput`
- 支持自动增长/缩放
- 处理键盘事件
- 跟踪文本和光标位置

**关键接口**:
```typescript
export interface MultiTextInputHandle {
    setTextAndSelection: (text: string, selection: { start: number; end: number }) => void;
    focus: () => void;
    blur: () => void;
}

export interface TextInputState {
    text: string;
    selection: {
        start: number;
        end: number;
    };
}
```

**Web 实现 (MultiTextInput.web.tsx)**:
- 基于 `react-textarea-autosize` 库
- 完整的文本选择跟踪 (行 132-145)
- 键盘事件处理（包括组合输入检测）(行 65-113)

**Web 键盘处理** (行 65-113):
```typescript
const handleKeyDown = React.useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 检测输入法组合状态（isComposing）
    const isComposing = e.nativeEvent.isComposing || (e.nativeEvent as any).isComposing || e.keyCode === 229;
    if (isComposing) {
        return;  // 忽略组合输入期间的事件
    }
    
    // 规范化按键名称
    let normalizedKey: SupportedKey | null = null;
    switch (e.key) {
        case 'Enter': normalizedKey = 'Enter'; break;
        case 'Tab': normalizedKey = 'Tab'; break;
        // ... 其他按键
    }
});
```

**文本和选择同步** (行 132-145):
```typescript
const handleSelect = React.useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    const selection = { 
        start: target.selectionStart, 
        end: target.selectionEnd 
    };
    
    if (onSelectionChange) {
        onSelectionChange(selection);
    }
    if (onStateChange) {
        onStateChange({ text: value, selection });
    }
}, [value, onSelectionChange, onStateChange]);
```

---

## 2. 图片上传相关代码

### 2.1 图片选择逻辑（AgentInput 组件）
**位置**: AgentInput.tsx，行 552-607

**两种实现方式**:

**Web 平台** (行 553-593):
```typescript
if (Platform.OS === 'web') {
    await new Promise<void>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/jpeg,image/png,image/webp,image/gif';
        
        // 监听窗口焦点变化（用于检测取消操作）
        let resolved = false;
        const onFocus = () => {
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve();
                }
                window.removeEventListener('focus', onFocus);
            }, 300);
        };
        window.addEventListener('focus', onFocus);
        
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) {
                if (!resolved) { resolved = true; resolve(); }
                return;
            }
            // 读取文件为 DataURL
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const dataUrl = reader.result as string;
                    const base64 = dataUrl.split(',')[1];
                    await uploadImageData(base64, file.type || 'image/jpeg');
                } finally {
                    if (!resolved) { resolved = true; resolve(); }
                }
            };
            reader.readAsDataURL(file);
        };
        input.click();
    });
}
```

**原生平台** (行 594-606):
```typescript
const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: false,
    quality: 0.85,
    base64: true,
});
if (result.canceled || !result.assets || result.assets.length === 0) return;
const asset = result.assets[0];
if (!asset.base64) return;

await uploadImageData(asset.base64, asset.mimeType ?? 'image/jpeg');
```

### 2.2 上传图片数据到服务器
**函数**: `uploadImageData` (行 535-547)
```typescript
const uploadImageData = React.useCallback(async (base64: string, rawMime: string) => {
    const mimeType = (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(rawMime)
        ? rawMime
        : 'image/jpeg') as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) return;
    const uploadResult = await uploadImage(credentials, base64, mimeType);
    setPendingImages(prev => [...prev, {
        uri: uploadResult.url,
        width: uploadResult.width,
        height: uploadResult.height,
    }]);
}, []);
```

### 2.3 图片上传 API
**文件路径**: `sources/sync/apiUpload.ts` (36 行)

```typescript
export interface UploadImageResult {
    url: string;
    width: number;
    height: number;
}

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
```

---

## 3. Web 平台特定功能 - 粘贴事件处理

### 3.1 粘贴图片支持
**位置**: AgentInput.tsx，行 612-640
**功能**: 监听全局粘贴事件，自动检测图片并上传

```typescript
React.useEffect(() => {
    if (Platform.OS !== 'web') return;

    const handlePaste = (event: ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.startsWith('image/')) {
                event.preventDefault();  // 阻止默认粘贴行为
                const file = item.getAsFile();
                if (!file) continue;

                const reader = new FileReader();
                reader.onload = () => {
                    const dataUrl = reader.result as string;
                    const base64 = dataUrl.split(',')[1];
                    uploadImageData(base64, file.type || 'image/jpeg').catch(console.error);
                };
                reader.readAsDataURL(file);
                break;  // 每次粘贴只处理第一张图片
            }
        }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
}, [uploadImageData]);
```

**关键设计**:
- ✅ 支持剪贴板图片
- ✅ 自动检测 MIME 类型
- ✅ 防止默认粘贴行为
- ✅ 只处理第一张图片（避免过多上传）
- ✅ 错误处理和清理

---

## 4. 待上传图片的显示和管理

### 4.1 图片预览渲染
**位置**: AgentInput.tsx，行 1123-1175

```typescript
{pendingImages.length > 0 && (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingTop: 8, gap: 8, flexWrap: 'wrap' }}>
        {pendingImages.map((img, index) => (
            <View key={index} style={{ position: 'relative' }}>
                <Image
                    source={{ uri: img.uri }}
                    style={{ width: 64, height: 64, borderRadius: 8 }}
                    contentFit="cover"
                />
                {/* 删除按钮 */}
                <Pressable
                    style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        backgroundColor: 'rgba(0,0,0,0.6)',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                    onPress={() => setPendingImages(prev => prev.filter((_, i) => i !== index))}
                >
                    <Text style={{ color: '#fff', fontSize: 10, lineHeight: 12 }}>✕</Text>
                </Pressable>
            </View>
        ))}
        {/* 添加更多图片按钮 */}
        <Pressable
            onPress={doPickImage}
            disabled={isPickingImage}
            style={(p) => ({
                width: 64,
                height: 64,
                borderRadius: 8,
                borderWidth: 1.5,
                borderColor: theme.colors.divider,
                borderStyle: 'dashed',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: p.pressed || isPickingImage ? 0.5 : 1,
                backgroundColor: theme.colors.surfacePressed,
            })}
        >
            {isPickingImage ? (
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
            ) : (
                <Ionicons name="add" size={24} color={theme.colors.textSecondary} />
            )}
        </Pressable>
    </View>
)}
```

**特点**:
- 水平滚动预览
- 每个图片可单独删除
- 添加更多图片按钮
- 加载状态指示

---

## 5. 消息发送流程

### 5.1 带图片的消息发送
**位置**: sources/-session/SessionView.tsx，行 366-374

```typescript
onSendWithImages={(images, text) => {
    const textToSend = text || message.trim() || undefined;
    sync.sendMessageWithImages(sessionId, images.map(img => ({ 
        url: img.uri, 
        width: img.width, 
        height: img.height 
    })), textToSend);
    if (message.trim()) {
        setMessage('');
        clearDraft();
    }
    trackMessageSent();
}}
```

### 5.2 Sync 层实现
**文件路径**: `sources/sync/sync.ts`，行 520-599

```typescript
async sendMessageWithImages(
    sessionId: string, 
    images: Array<{ url: string; width: number; height: number }>, 
    text?: string
) {
    // 获取加密对象
    const encryption = this.encryption.getSessionEncryption(sessionId);
    
    // 确定发送源平台
    let sentFrom: string;
    if (Platform.OS === 'web') {
        sentFrom = 'web';
    } else if (Platform.OS === 'android') {
        sentFrom = 'android';
    } else if (Platform.OS === 'ios') {
        sentFrom = isRunningOnMac() ? 'mac' : 'ios';
    } else {
        sentFrom = 'web';
    }
    
    // 创建内容块数组（支持文本和图片混合）
    const contentBlocks: Array<
        { type: 'text'; text: string } | 
        { type: 'image_url'; url: string; width?: number; height?: number }
    > = [];
    
    if (text?.trim()) {
        contentBlocks.push({
            type: 'text',
            text: text,
        });
    }
    
    for (const img of images) {
        contentBlocks.push({
            type: 'image_url',
            url: img.url,
            width: img.width,
            height: img.height,
        });
    }
    
    // 创建消息对象并加密
    const content: RawRecord = {
        role: 'user',
        content: contentBlocks,
        meta: {
            sentFrom,
            permissionMode,
            model,
            fallbackModel: null,
            appendSystemPrompt: null,
        }
    };
    
    // ... 加密和发送逻辑
}
```

---

## 6. 自动完成功能

### 6.1 相关 Hooks
**文件位置**: `sources/components/autocomplete/`

关键文件:
- `useActiveWord.ts` - 检测活动词
- `useActiveSuggestions.ts` - 管理建议列表
- `applySuggestion.ts` - 应用建议

### 6.2 键盘导航
**位置**: AgentInput.tsx，行 643-703

```typescript
const handleKeyPress = React.useCallback((event: KeyPressEvent): boolean => {
    // 处理自动完成导航
    if (suggestions.length > 0) {
        if (event.key === 'ArrowUp') {
            moveUp();
            return true;
        } else if (event.key === 'ArrowDown') {
            moveDown();
            return true;
        } else if ((event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
            // Enter 或 Tab 选择当前建议
            const indexToSelect = selected >= 0 ? selected : 0;
            handleSuggestionSelect(indexToSelect);
            return true;
        } else if (event.key === 'Escape') {
            // Escape 清除建议
            if (inputRef.current) {
                const cursorPos = inputState.selection.start;
                inputRef.current.setTextAndSelection(inputState.text, {
                    start: cursorPos,
                    end: cursorPos
                });
            }
            return true;
        }
    }
    
    // 处理 Web 平台特定的按键
    if (Platform.OS === 'web') {
        // Enter 发送消息（仅在非触摸设备上）
        const isTouchDevice = typeof window !== 'undefined' && 
            ('ontouchstart' in window || navigator.maxTouchPoints > 0);
        if (agentInputEnterToSend && event.key === 'Enter' && !event.shiftKey && !isTouchDevice) {
            if (props.value.trim() || pendingImages.length > 0) {
                if (isSendBlocked) {
                    handleBlockedSendAttempt();
                } else if (!props.isSendDisabled) {
                    handleSendPress();
                }
                return true;
            }
        }
        
        // Shift+Tab 切换权限模式
        if (event.key === 'Tab' && event.shiftKey && 
            props.onPermissionModeChange && availableModes.length > 0) {
            const currentIndex = availableModes.findIndex(
                (mode) => mode.key === permissionModeKey
            );
            const nextIndex = ((currentIndex >= 0 ? currentIndex : 0) + 1) % availableModes.length;
            props.onPermissionModeChange(availableModes[nextIndex]);
            return true;
        }
    }
    
    return false;
}, [/* 依赖数组 */]);
```

---

## 7. 相关 Hooks 和工具

### 7.1 useHappyAction Hook
**文件路径**: `sources/hooks/useHappyAction.ts`

```typescript
export function useHappyAction(action: () => Promise<void>) {
    const [loading, setLoading] = React.useState(false);
    const loadingRef = React.useRef(false);
    const doAction = React.useCallback(() => {
        if (loadingRef.current) return;
        
        loadingRef.current = true;
        setLoading(true);
        (async () => {
            try {
                await action();
            } catch (e) {
                if (e instanceof HappyError) {
                    Modal.alert('Error', e.message, [{ text: 'OK', style: 'cancel' }]);
                } else {
                    Modal.alert('Error', 'Unknown error', [{ text: 'OK', style: 'cancel' }]);
                }
            } finally {
                loadingRef.current = false;
                setLoading(false);
            }
        })();
    }, [action]);
    return [loading, doAction] as const;
}
```

**在 AgentInput 中的使用** (行 552):
```typescript
const [isPickingImage, doPickImage] = useHappyAction(React.useCallback(async () => {
    // 图片选择逻辑
}, [uploadImageData]));
```

### 7.2 useDraft Hook
**用途**: 自动保存消息草稿
**位置**: sources/hooks/useDraft.ts

---

## 8. Web 平台特定文件

### 已识别的 Web 特定实现:
```
sources/components/MultiTextInput.web.tsx          - 文本输入
sources/components/Shaker.web.tsx                 - 震动反馈
sources/components/haptics.web.ts                 - 触觉反馈
sources/components/PlusPlus.web.tsx               - UI 组件
sources/components/qr/QRCode.web.tsx              - 二维码
sources/components/SessionActionsNativeMenu.web.tsx - 菜单
sources/realtime/RealtimeProvider.web.tsx         - 实时通信
sources/realtime/RealtimeVoiceSession.web.tsx     - 语音
sources/sync/revenueCat/revenueCat.web.ts         - 购买
sources/encryption/libsodium.lib.web.ts           - 加密
sources/utils/loadSkia.web.ts                     - 图形库
```

---

## 9. 关键技术细节

### 9.1 事件处理链
```
用户粘贴或点击按钮
  ↓
uploadImageData() 被调用
  ↓
uploadImage() API 调用
  ↓
图片 URL 和尺寸返回
  ↓
pendingImages 状态更新
  ↓
预览渲染
  ↓
用户点击发送
  ↓
onSendWithImages() 回调
  ↓
sync.sendMessageWithImages()
  ↓
消息加密和发送
```

### 9.2 平台检测
```typescript
Platform.OS === 'web'    // Web 平台
Platform.OS === 'ios'    // iOS
Platform.OS === 'android' // Android

// 检测是否在 Mac 上运行
isRunningOnMac()
```

### 9.3 MIME 类型支持
- ✅ `image/jpeg`
- ✅ `image/png`
- ✅ `image/webp`
- ✅ `image/gif`

---

## 10. 文件清单

### 核心组件
| 文件 | 行数 | 功能 |
|------|------|------|
| `AgentInput.tsx` | 1432 | 主要输入组件 + 图片上传 |
| `MultiTextInput.tsx` | 150 | 原生文本输入 |
| `MultiTextInput.web.tsx` | 213 | Web 文本输入 |
| `ChatFooter.tsx` | 50 | 底部信息条 |

### API 和 Sync
| 文件 | 行数 | 功能 |
|------|------|------|
| `apiUpload.ts` | 36 | 图片上传 API |
| `sync.ts` | ~600+ | 消息发送和同步 |

### 页面和视图
| 文件 | 行数 | 功能 |
|------|------|------|
| `SessionView.tsx` | 400+ | 会话页面（包含输入整合） |

### Hooks 和工具
| 文件 | 功能 |
|------|------|
| `useHappyAction.ts` | 异步操作处理 |
| `useDraft.ts` | 草稿保存 |
| `useAutocomplete.ts` | 自动完成 |
| `AutoComplete/` | 自动完成相关 |

---

## 11. 设计模式和最佳实践

### 11.1 状态管理
- 使用 React Hooks 管理本地状态
- 使用 Zustand Store（`storage` 对象）管理全局状态
- 草稿自动保存机制

### 11.2 错误处理
- `useHappyAction` 包装异步操作
- 自动重试机制（见 useHappyAction）
- Modal 显示错误信息

### 11.3 平台兼容性
- 使用 `Platform.OS` 检测平台
- `.web.tsx` 和 `.native.tsx` 扩展
- 条件渲染 Web 特定功能（粘贴、文件选择）

### 11.4 性能优化
- 使用 `React.memo()` 避免不必要的重新渲染
- 使用 `useCallback()` 稳定函数引用
- 使用 `useMemo()` 缓存计算结果

---

## 12. 总结

这个项目实现了一个完整的跨平台消息输入系统，具有以下特点：

✅ **多平台支持**: Web、iOS、Android、macOS
✅ **图片上传**: 支持文件选择和粘贴
✅ **实时同步**: WebSocket 基础的实时消息同步
✅ **端到端加密**: 使用 libsodium 加密所有消息
✅ **自动完成**: 支持 @ 和 / 前缀的命令自动完成
✅ **草稿保存**: 自动保存未发送的消息
✅ **丰富功能**: 权限模式、模型选择、语音输入、Git 状态等

主要的创新点是在 Web 平台上实现了无缝的粘贴图片支持，同时保持了与原生平台的 API 兼容性。
