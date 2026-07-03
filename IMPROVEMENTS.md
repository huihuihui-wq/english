# Shadow Reader 英语学习项目 - 改进文档

## 项目概述

**Shadow Reader** 是一个基于 React + FastAPI 的英语学习 Web 应用，核心功能包括：
- 视频播放 + 字幕同步显示
- AI 助手（聊天、测验、解释、生成）
- 单词查询与词汇本
- 语音合成 (TTS)
- 本地语音识别 (ASR)

**技术栈：**
- 前端：React 19 + TypeScript + Vite + Tailwind CSS + Zustand
- 后端：FastAPI + Python + DashScope (阿里云大模型)
- 基础设施：Tailscale (远程访问)

---

## 一、已发现的 Bug

### 🔴 严重级别

#### 1. VideoPlayer.tsx - 内存泄漏与状态不同步

**问题描述：**
- `useEffect` 依赖项不完整，导致事件监听器可能重复注册
- 组件卸载时 `setPlayerRef(null)` 会触发状态更新，但此时组件可能已卸载
- 键盘事件监听在窗口级别，没有正确清理

**影响：**
- 内存泄漏，长时间使用后页面卡顿
- 快速切换视频时播放器状态混乱

**修复建议：**
```typescript
// 1. 完善依赖项
useEffect(() => {
  if (!videoRef.current) return;
  
  setPlayerRef(videoRef.current);
  const video = videoRef.current;
  
  // 事件处理...
  
  return () => {
    video.pause(); // 先暂停
    video.removeEventListener('timeupdate', handleTimeUpdate);
    video.removeEventListener('loadedmetadata', handleLoadedMetadata);
    video.removeEventListener('ended', handleEnded);
    setPlayerRef(null);
  };
}, [videoUrl, setPlayerRef, updateCurrentTime, setDuration, playbackRate]);

// 2. 使用 ref 存储回调，避免闭包问题
const callbacksRef = useRef({
  handleTimeUpdate: () => {},
  handleLoadedMetadata: () => {},
  handleEnded: () => {}
});
```

#### 2. playerStore.ts - 播放状态竞态条件

**问题描述：**
- `togglePlay` 先操作 DOM，再更新状态，假设操作一定成功
- 浏览器可能阻止自动播放（策略限制），导致状态与实际不同步
- 没有错误处理

**影响：**
- 用户点击播放但视频没动，按钮却显示播放中
- 移动端尤其容易出问题

**修复建议：**
```typescript
togglePlay: async () => {
  const { isPlaying, playerRef } = get();
  if (!playerRef) return;
  
  try {
    if (isPlaying) {
      await playerRef.pause();
      set({ isPlaying: false });
    } else {
      const playPromise = playerRef.play();
      if (playPromise !== undefined) {
        await playPromise;
        set({ isPlaying: true });
      }
    }
  } catch (error) {
    console.error('Playback failed:', error);
    set({ isPlaying: false }); // 回滚状态
    // 可以触发一个 toast 通知用户
  }
},
```

#### 3. ai.ts - 伪流式实现

**问题描述：**
- `streamChat` 声称是流式，实际是完整请求后模拟打字效果
- 大段文本时用户需要等待全部生成完成才能看到第一个字
- 没有真正的 SSE 连接

**影响：**
- AI 响应慢，用户体验差
- 内存占用高（需要缓存完整响应）

**修复建议：**
```typescript
// 实现真正的 SSE
export async function* streamChat(
  req: ChatRequest,
  signal?: AbortSignal
): AsyncGenerator<StreamEvent, void, void> {
  const response = await fetch(`${API_BASE}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');
  
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    // 解析 SSE 格式...
    yield { type: 'delta', content: parsed };
  }
}
```

---

### 🟡 中等级别

#### 4. App.tsx - 硬编码演示数据

**问题描述：**
- 字幕和视频 URL 直接写在代码里
- 无法加载用户自己的内容
- 每次刷新都重新解析相同的 SRT

**影响：**
- 只能看演示视频，无法实际使用
- 开发/测试与生产环境没有区分

**修复建议：**
```typescript
// 添加文件上传支持
function App() {
  const [videoSource, setVideoSource] = useState<VideoSource | null>(null);
  
  // 从 localStorage 或 URL 参数加载
  useEffect(() => {
    const saved = localStorage.getItem('last-video');
    if (saved) {
      setVideoSource(JSON.parse(saved));
    }
  }, []);
  
  if (!videoSource) {
    return <WelcomeScreen onLoad={setVideoSource} />;
  }
  
  return <ResponsiveLayout videoSource={videoSource} />;
}
```

#### 5. main.py - 异常处理过于宽泛

**问题描述：**
- 全局异常处理器捕获所有 Exception
- 返回 500 错误时包含完整 traceback（安全风险）
- 没有区分业务错误和系统错误

**影响：**
- 可能泄露敏感信息（路径、内部实现）
- 客户端无法区分可恢复和不可恢复的错误

**修复建议：**
```python
# 1. 定义业务异常
class BusinessError(Exception):
    """可预期的业务错误"""
    pass

class ValidationError(BusinessError):
    pass

class ResourceNotFound(BusinessError):
    pass

# 2. 分类处理
@app.exception_handler(BusinessError)
async def handle_business_error(request, exc):
    return JSONResponse(
        status_code=400,
        content={"error": exc.__class__.__name__, "message": str(exc)}
    )

@app.exception_handler(Exception)
async def handle_unexpected_error(request, exc):
    logger.exception("Unexpected error")
    # 生产环境不返回 traceback
    return JSONResponse(
        status_code=500,
        content={"error": "Internal Server Error"}
    )
```

#### 6. AIPanel.tsx - 缺少错误边界

**问题描述：**
- 没有 React Error Boundary
- 任何子组件崩溃会导致整个 AI 面板白屏
- 用户只能刷新页面恢复

**修复建议：**
```typescript
// 添加 Error Boundary
class AIErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-4 text-center">
          <p className="text-red-400">AI 助手出错了</p>
          <button 
            onClick={() => this.setState({ hasError: false })}
            className="mt-2 px-3 py-1 bg-blue-600 rounded"
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

---

## 二、体验问题

### 1. 缺少加载真实内容的功能 ⭐⭐⭐

**现状：**
- 只能看内置的演示视频
- 没有文件上传、URL 输入、历史记录加载

**期望：**
- 支持上传本地视频 + SRT 字幕
- 支持 YouTube/Bilibili 链接解析
- 支持拖拽上传
- 历史记录自动保存和恢复

**实现建议：**
```typescript
// 添加文件上传组件
function FileUploader() {
  const onDrop = useCallback((files: FileList) => {
    const video = files.find(f => f.type.startsWith('video/'));
    const subtitle = files.find(f => f.name.endsWith('.srt'));
    
    if (video && subtitle) {
      loadVideo(URL.createObjectURL(video), subtitle);
    }
  }, []);
  
  return (
    <div 
      {...useDropzone({ onDrop })}
      className="border-2 border-dashed border-gray-600 rounded-lg p-8 text-center hover:border-blue-500"
    >
      <p>拖拽视频和字幕文件到这里</p>
      <p className="text-sm text-gray-500">或点击选择文件</p>
    </div>
  );
}
```

### 2. 移动端体验差 ⭐⭐⭐

**现状：**
- 虽然有 ResponsiveLayout，但触摸控制不完善
- 字幕点击区域太小
- 没有手势支持（滑动快进、捏合缩放）

**期望：**
- 双击快进/快退 10 秒
- 左右滑动调节进度
- 上下滑动调节音量
- 字幕区域可双指缩放字体

### 3. AI 响应慢，没有加载状态 ⭐⭐

**现状：**
- 点击发送后没有视觉反馈
- 用户不知道是否在处理
- 网络慢时感觉像卡死了

**期望：**
- 发送按钮变 loading 状态
- 显示 "AI 正在思考..." 动画
- 流式输出，逐字显示

### 4. 没有离线模式 ⭐⭐

**现状：**
- 所有 AI 功能依赖 DashScope API
- 网络断开时完全无法使用
- 没有缓存机制

**期望：**
- 本地词典查询可离线
- 已加载的视频和字幕可离线查看
- 历史记录本地存储
- 网络恢复后自动同步

### 5. 设置分散，没有统一配置面板 ⭐

**现状：**
- API key 在右上角设置
- 模型选择分散在各处
- 没有用户偏好记忆

**期望：**
- 统一设置面板（快捷键、默认模型、界面主题）
- 导出/导入配置
- 多用户配置切换

---

## 三、架构改进建议

### 1. 前端状态管理优化

**现状：**
- Zustand store 越来越大
- 没有分层，所有状态混在一起
- 持久化逻辑分散

**建议：**
```typescript
// 分层架构
stores/
  player/          // 播放器状态
    index.ts
    actions.ts
    selectors.ts
  subtitle/        // 字幕状态
  ai/              // AI 状态
  ui/              // UI 状态（主题、布局）
  
// 使用 selector 优化重渲染
export const useCurrentSubtitle = () => 
  useSubtitleStore(selectCurrentSubtitle);
```

### 2. 后端 API 优化

**现状：**
- 所有逻辑在 main.py 中
- 没有服务层抽象
- 测试困难

**建议：**
```
services/
  __init__.py
  player_service.py      # 播放器相关业务
  subtitle_service.py    # 字幕处理
  ai_service.py          # AI 交互
  cache_service.py       # 缓存管理
  file_service.py        # 文件上传/下载
  
routers/
  __init__.py
  player.py              # 播放器 API
  subtitles.py           # 字幕 API
  ai.py                  # AI API
  files.py               # 文件 API
```

### 3. 添加测试

**现状：**
- 没有单元测试
- 没有 E2E 测试
- 依赖手动测试

**建议：**
```typescript
// 前端测试
__tests__/
  components/
    VideoPlayer.test.tsx
    AIPanel.test.tsx
  stores/
    playerStore.test.ts
  utils/
    subtitleParser.test.ts

// 后端测试
tests/
  test_transcribe.py
  test_translate.py
  test_ai_service.py
```

### 4. 性能优化

**现状：**
- 字幕列表没有虚拟化，长视频卡顿
- 视频没有预加载
- 图片/音频没有缓存策略

**建议：**
```typescript
// 虚拟化字幕列表
import { VirtualList } from 'react-window';

function SubtitleList({ items }) {
  return (
    <VirtualList
      height={400}
      itemCount={items.length}
      itemSize={40}
      renderItem={({ index, style }) => (
        <SubtitleItem 
          key={items[index].id}
          style={style}
          data={items[index]}
        />
      )}
    />
  );
}
```

---

## 四、优先级排序

### 立即修复（本周）
1. ✅ 修复 VideoPlayer 内存泄漏
2. ✅ 修复 playerStore 播放状态竞态
3. ✅ 添加 Error Boundary
4. ✅ 添加 AI 加载状态

### 短期改进（本月）
5. 实现文件上传功能
6. 实现真正的 SSE 流式
7. 添加移动端手势支持
8. 优化异常处理

### 中期规划（3个月）
9. 重构前端状态管理
10. 后端服务拆分
11. 添加测试覆盖
12. 实现离线模式

### 长期愿景（6个月）
13. 支持多语言界面
14. 社区功能（分享字幕、评分）
15. 插件系统（自定义 AI 模型）
16. 桌面/移动端 App（Electron/React Native）

---

## 五、技术债务

| 问题 | 影响 | 解决成本 | 建议时间 |
|------|------|---------|---------|
| 硬编码演示数据 | 无法实际使用 | 低 | 立即 |
| 伪流式实现 | 用户体验差 | 中 | 本周 |
| 缺少测试 | 回归风险高 | 高 | 本月 |
| 状态管理混乱 | 维护困难 | 中 | 本月 |
| 后端单体架构 | 扩展性差 | 高 | 3个月 |
| 缺少离线支持 | 网络依赖强 | 高 | 3个月 |

---

## 六、参考资源

- [React 性能优化](https://react.dev/reference/react)
- [Zustand 最佳实践](https://docs.pmnd.rs/zustand/guides/practice-with-no-store-actions)
- [FastAPI 项目结构](https://fastapi.tiangolo.com/tutorial/bigger-applications/)
- [WebVTT 字幕标准](https://developer.mozilla.org/en-US/docs/Web/API/WebVTT_API)
- [Media Source Extensions](https://developer.mozilla.org/en-US/docs/Web/API/Media_Source_Extensions_API)

---

**文档版本：** v1.0  
**生成时间：** 2026-07-03  
**基于代码版本：** Shadow Reader v0.2.0
