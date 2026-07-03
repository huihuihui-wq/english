# Shadow Reader 英语学习项目 — 问题诊断与改进汇报

> **版本：** v0.2.0  
> **分析日期：** 2026-07-03  
> **分析范围：** shadow-reader（原生 JS） + english-learning-web（React/Vite）双前端 + FastAPI 后端

---

## 一、核心问题总览

| 类别 | 数量 | 关键结论 |
|------|------|----------|
| 🔴 严重 Bug | 6 | 硬编码演示数据、前端分裂、状态不同步、内存泄漏隐患 |
| 🟡 功能缺陷 | 8 | 非真正影子跟读、词汇存储简陋、缺少内容加载 |
| 🟢 体验瑕疵 | 7 | 移动端不完善、AI 伪流式、无离线模式、设置分散 |
| 🔵 架构债务 | 5 | 状态管理混乱、后端单体、无测试、无持久化设计 |

---

## 二、🔴 严重 Bug（需立即修复）

### 2.1 english-learning-web 完全无法实际使用 — 硬编码演示数据

**问题：** `App.tsx` 第 12-69 行，所有内容均为硬编码：
- 视频固定为 `BigBuckBunny.mp4`（与黄仁勋演讲字幕不匹配）
- 字幕固定为 10 句演示 SRT，无文件上传入口
- 每次刷新丢失所有学习进度
- `ResponsiveLayout` 虽然有响应式断点，但没有任何加载真实内容的逻辑

**影响：** React 版前端是一个**纯演示壳**，无法加载用户自己的视频/字幕，不具备实际使用价值。

**修复方向：** 接入后端 `/api/transcribe`、`/api/generate-subtitles` 和历史记录 API，或至少提供文件上传和 URL 输入功能。

---

### 2.2 双前端并存但数据与状态完全隔离

**问题：** 项目同时存在两个前端：
- `shadow-reader/frontend/` — 原生 JS/HTML，功能完整（上传、YouTube、历史、词汇、设置）
- `english-learning-web/` — React/Vite/TypeScript，功能残缺（仅演示视频+AI 聊天）

**影响：**
- 维护两套 UI 代码，重复劳动
- React 版无法复用原生版已有的后端 API（上传、转录、YouTube 下载、翻译）
- 用户困惑：到底用哪个版本？

**建议：** 以 `shadow-reader` 的原生版作为**功能基线**，React 版要么重写为功能对等，要么废弃。

---

### 2.3 VideoPlayer 事件监听仍有潜在内存泄漏

**问题：** `VideoPlayer.tsx` 第 33-74 行：
- `return () => { video.pause(); ... }` 中 `video.pause()` 在组件卸载时调用可能触发错误
- `toggleFullscreen` 函数定义在 `useEffect` 之后（第 130 行），但第 124-128 行的 `useEffect` 依赖 `toggleFullscreen` 这个 `useCallback` 结果，两者存在循环依赖风险
- 空依赖的键盘事件监听 `useEffect([])`（第 117-121 行）虽然避免了重复注册，但 `handleKeyDown` 内部通过 `usePlayerStore.getState()` 获取状态，虽不触发闭包问题，但全局 window 事件监听没有区分不同播放器实例

**影响：** 快速切换路由/视频时可能出现事件残留或状态错乱。

---

### 2.4 逐句复读（useSentenceShadowing）逻辑存在时序 Bug

**问题：** `useSentenceShadowing.ts` 第 14-59 行：

1. **时间精度问题：** `currentTime >= currentCue.endTime - 50` 中 `currentTime` 是毫秒（来自 `playerStore`），但 `endTime` 也是毫秒，`-50` 的容差在倍速播放时可能失效或提前触发。
2. **ID 连续性假设错误：** `cues.find((c) => c.id === currentCueId + 1)` 假设字幕 ID 是连续整数。如果字幕解析时有跳号（如删除了某些句子），此逻辑会找不到下一句，导致复读中断。
3. **没有清理机制：** 当用户手动 seek 到非当前句时，`lastCueRef` 不会重置，可能导致该句被跳过不触发复读。

**影响：** 逐句复读功能在边缘情况下不稳定，可能跳过句子或无法继续。

---

### 2.5 全局异常处理器泄露敏感信息

**问题：** `main.py` 第 59-71 行：
```python
@app.exception_handler(Exception)
async def _unhandled_exception_handler(request, exc):
    tb = traceback.format_exc()
    return JSONResponse(
        status_code=500,
        content={
            "detail": f"{type(exc).__name__}: {exc}",
            "traceback": tb.splitlines()[-12:],  # 返回 traceback 给前端！
        },
    )
```

**影响：** 生产环境下向客户端暴露完整的 Python traceback，包含文件路径、内部实现细节，存在**信息泄露安全风险**。

---

### 2.6 AI 伪流式实现 — 用户体验差

**问题：** `api/ai.ts` 第 86-104 行：
- `streamChat` 声称是流式，实际是完整请求后通过 `chunkString(res.reply, 24)` 模拟打字效果
- 大段文本时用户需要等待全部生成完成才能看到第一个字
- 没有真正的 SSE 连接，也没有 AbortSignal 的及时响应

**影响：** 网络慢时 AI 回复完全空白，用户以为卡死。与真正流式体验差距巨大。

---

## 三、🟡 功能缺陷（关键体验受损）

### 3.1 React 版不是真正的影子跟读法

**问题对比：**

| 功能 | shadow-reader（原生版） | english-learning-web（React版） |
|------|------------------------|------------------------------|
| 单句循环 | ✅ `loopCount` 可配置 1-10 次 | ❌ 无 |
| 延迟跟读 | ✅ `delaySec` 支持 0-5 秒延迟 | ❌ 无 |
| 句间暂停 | ✅ `pauseSec` 可配置 0-10 秒 | ✅ `shadowingPauseMs` 仅有暂停 |
| 跳过静音段 | ✅ 自动跳过 placeholder | ✅ 支持 |
| 用户录音比对 | ❌ 无 | ❌ 无 |
| 发音评分 | ❌ 无 | ❌ 无 |
| 波形可视化 | ❌ 无 | ❌ 无 |

**结论：** React 版的 "逐句复读" 只是**自动播放下一句并暂停**，不具备真正的 Shadowing（跟读）核心要素：
1. **没有用户录音环节** — 无法知道自己读得对不对
2. **没有延迟跟读模式** — 无法练习 "echoing"
3. **没有循环精听** — 无法反复听同一句话
4. **没有发音评估** — 没有反馈机制

**建议：** 真正的影子跟读应至少包含：
- 单句循环播放（3-5 次）
- 延迟 0.5-2 秒后用户跟读
- 可选的 ASR 录音比对（后端已有 `/api/ai/voice-chat`，可复用）
- 最低限度：循环 + 延迟 + 录音播放

---

### 3.2 词汇本（Vocabulary）存储严重不足

**问题：** 后端 `vocabulary.py` 使用单文件 JSON 存储：

```python
VOCAB_FILE = DATA_DIR / "vocabulary.json"
_cache: Optional[dict] = None
```

**缺陷清单：**

1. **O(n) 线性查找：** `has_word()` 和 `get_word()` 遍历整个列表，单词量 > 1000 时明显变慢
2. **无搜索索引：** 没有按词性、来源、时间、掌握程度等维度索引
3. **无学习状态字段：** 没有 `proficiency`（熟练度）、`review_count`（复习次数）、`next_review`（下次复习时间）、`forgotten`（遗忘标记）等 SRS 必需字段
4. **无上下文关联：** 保存单词时虽传了 `source_history_id`，但 React 版前端没有展示 "这个词来自哪个视频/哪句话"
5. **无导出格式：** 只能导出 JSON，无法导出 Anki CSV、Quizlet 等主流格式
6. **无学习统计：** 没有每日学习量、掌握率、遗忘率等图表
7. **无标签/分组：** 无法按主题、难度、来源视频分组管理

---

### 3.3 React 版没有展示词汇本列表

**问题：** `VocabularyPanel.tsx` 只实现了**单个单词的查询详情**面板，没有：
- 已保存单词的总览列表
- 搜索/筛选功能
- 删除/编辑功能
- 导出功能

**对比：** shadow-reader 原生版有完整的 `Vocab` 模块（`vocabulary.js`），支持卡片式展示、展开详情、发音、删除、搜索、导出。

---

### 3.4 单词点击查词不准确

**问题：** `SubtitleItem.tsx` 第 44-56 行：
```typescript
const words = text.split(/(\s+)/);
```

1. **标点符号被当作单词：** 英文句子中的逗号、句号会被 `split` 单独作为一个 `word`，虽然 `WordSpan` 的 `replace(/[^a-zA-Z0-9'-]/g, '')` 会过滤，但用户点击标点区域时没有任何反馈（虽然不会触发查词，但体验不佳）。
2. **连字符单词处理：** `"well-known"` 被 `replace(/[^a-zA-Z0-9'-]/g, '')` 保留后变成 `"well-known"`，但 `word_tokenize.py` 的 `is_english_word` 可能无法正确识别带连字符的复合词。
3. **副标题 overlay 的单词分割同样有问题：** `SubtitleOverlay.tsx` 第 29-41 行使用相同的分割逻辑。

---

### 3.5 没有内容加载入口（React 版）

**问题：** React 版没有任何方式让用户：
- 上传本地视频/音频文件
- 上传 SRT/VTT 字幕文件
- 输入 YouTube/Bilibili/MP4 链接
- 从历史记录中恢复学习进度

**后端已有能力但 React 版未接入：**
- `/api/transcribe` — 本地音视频转录+翻译
- `/api/generate-subtitles` — YouTube 字幕获取 / AI 生成
- `/api/history` — 历史记录 CRUD
- `/api/translate-subtitles` — 字幕批量翻译

---

### 3.6 AB 复读功能不完整

**问题：** `useABRepeat.ts` 实现了 A/B 点设置，但：
- 没有 UI 指示当前 AB 范围（无视觉标记）
- 没有快捷键绑定（在 `usePanelShortcuts.ts` 中检查）
- `StudyToolsBar.tsx` 的 AB 复读按钮文案 confusing：`设B点` / `清除AB` 的切换逻辑不直观
- 没有波形/时间轴可视化来拖拽 A/B 点

---

### 3.7 移动端体验不完善

**问题：** `MobileLayout.tsx`：
- 视频播放器下方没有字幕叠加层（与 Desktop 不同）
- 面板切换是抽屉式设计，但 `max-h-[60vh]` 的动画不够流畅
- 没有触摸手势：双击快进/快退、左右滑动调进度、捏合缩放字幕
- 字幕列表在移动端点击区域过小
- AI 面板在移动端以 `AIPanelContent` 接入，但内容未针对移动端优化

---

### 3.8 设置分散，无统一配置面板

**问题：** React 版的设置：
- 字幕样式在 `SubtitleSettingsPanel`（颜色、字体、位置）
- 播放速度在 `PlayerControls` 和 `StudyToolsBar`
- 倍速按钮在两个地方同时出现，重复
- 没有后端配置同步（API key、模型选择等只能在 shadow-reader 原生版设置）

---

## 四、🟢 体验瑕疵

| # | 问题 | 位置 | 严重程度 |
|---|------|------|----------|
| 1 | AI 发送后没有 loading 状态（有 UI 但不够明显） | `ChatMode.tsx` | 中 |
| 2 | 没有离线模式 | 全局 | 中 |
| 3 | 字幕列表没有虚拟化，长视频（>1000 句）会卡顿 | `SubtitleList.tsx` | 中 |
| 4 | 进度条 hover 时间提示位置计算可能越界 | `PlayerControls.tsx` | 低 |
| 5 | 音量滑块仅在 hover 时显示，触摸设备无法操作 | `PlayerControls.tsx` | 中 |
| 6 | 没有键盘快捷键说明页 | 全局 | 低 |
| 7 | 遮挡板（Occlusion）的 `blur-[4px]` 在 subtitle item 和 `blur-[6px]` 在 overlay 不统一 | `SubtitleItem.tsx` / `SubtitleOverlay.tsx` | 低 |

---

## 五、🔵 架构与技术债务

### 5.1 状态管理混乱

**问题：** Zustand store 结构不清晰：
- `playerStore` 同时管理 video 信息、DOM ref、播放状态、音量、倍速、全屏
- `subtitleStore` 同时管理字幕数据、搜索、词汇查询、面板切换、设置
- `studyStore` 和 `aiStore` 分离较好，但 `aiStore` 的 `updateLastAssistant` 遍历数组效率低

**建议：** 按领域分层：
```
stores/
  player/     # 播放状态
  subtitle/   # 字幕数据
  search/     # 搜索
  vocab/      # 词汇查询
  ai/         # AI 状态
  ui/         # 主题、布局、设置
```

### 5.2 后端单体架构

**问题：** `main.py` 1599 行，所有路由在一个文件中：
- 虽然已拆分 `services/` 目录，但路由注册仍集中
- 没有依赖注入，测试困难

### 5.3 没有测试覆盖

**问题：** 前后端均无单元测试、E2E 测试。关键路径如字幕解析、跟读逻辑、词汇 CRUD 均依赖手动测试。

### 5.4 前端没有持久化策略

**问题：** React 版除了 `aiStore` 使用 `zustand/persist`，其他状态（字幕设置、学习进度、播放位置）均不持久化。刷新页面后完全重置。

### 5.5 字典缓存没有过期策略

**问题：** `dictionary.py` 的磁盘缓存永久保存，不会过期。如果单词释义更新或用户切换目标语言，旧缓存不会自动刷新（除非手动 `force_refresh`）。

---

## 六、优先级排序与修复建议

### 6.1 P0 — 立即修复（阻塞使用）

| # | 任务 | 预估工时 | 建议做法 |
|---|------|----------|----------|
| 1 | 统一前端：废弃 React 版或将其功能补齐至与原生版对等 | 2-3 周 | 评估维护成本，如果 React 版是长期目标，则迁移原生版功能 |
| 2 | 接入内容加载（上传/URL/历史）到 React 版 | 3-5 天 | 复用原生版已有的后端 API，封装 `FileUploader`、`LinkInput`、`HistoryLoader` 组件 |
| 3 | 修复全局异常处理器信息泄露 | 30 分钟 | 生产环境不返回 traceback，仅记录日志 |
| 4 | 修复逐句复读的 ID 连续性假设 | 1-2 小时 | 使用 `findIndex` 找当前 cue 的下标，再取下一个元素 |

### 6.2 P1 — 短期改进（1-2 周）

| # | 任务 | 预估工时 | 建议做法 |
|---|------|----------|----------|
| 5 | 实现真正的影子跟读：循环 + 延迟 + 录音 | 1 周 | 复用后端 ASR 和 TTS，前端增加 `MediaRecorder` 录音、循环计数器、延迟计时器 |
| 6 | 完善词汇本：列表展示 + 搜索 + 删除 | 3-5 天 | 复用 `vocabulary.js` 的 UI 设计，用 React 重写卡片式布局 |
| 7 | 实现真正的 SSE 流式 AI | 2-3 天 | 后端 `/api/ai/chat` 改为生成器，前端用 `EventSource` 或 `fetch` + `ReadableStream` |
| 8 | 添加 React Error Boundary | 2 小时 | 已部分实现（`AIPanel` 有），但需覆盖更多边界 |

### 6.3 P2 — 中期规划（1 个月）

| # | 任务 | 预估工时 | 建议做法 |
|---|------|----------|----------|
| 9 | 词汇本 SRS 学习系统 | 1-2 周 | 增加 `proficiency`、`next_review` 字段，实现简单间隔重复算法 |
| 10 | 前端状态持久化 | 3-5 天 | 所有 store 使用 `zustand/persist`，学习进度同步到后端 history |
| 11 | 字幕列表虚拟化 | 1-2 天 | 使用 `react-window` 或 `react-virtuoso` |
| 12 | 添加测试覆盖 | 1 周 | 前端用 Vitest + React Testing Library，后端用 pytest |
| 13 | 移动端手势支持 | 3-5 天 | 双击快进/快退、滑动调节进度、捏合缩放字幕 |

### 6.4 P3 — 长期愿景（3 个月）

| # | 任务 | 预估工时 | 建议做法 |
|---|------|----------|----------|
| 14 | 发音评分与波形对比 | 2-3 周 | 集成 whisper 字级时间戳，对比用户录音与原文的时间对齐 |
| 15 | 离线模式（PWA） | 2-3 周 | Service Worker 缓存视频、字幕、词典；IndexedDB 存词汇本 |
| 16 | 多用户/多设备同步 | 2-3 周 | 用户系统 + 云端同步 |
| 17 | 插件系统（自定义 AI 模型） | 2-3 周 | 抽象 AI provider 接口 |

---

## 七、技术债务矩阵

| 问题 | 影响范围 | 解决成本 | 建议修复时间 |
|------|----------|----------|--------------|
| 硬编码演示数据 | React 版完全不可用 | 低 | 立即 |
| 双前端并存 | 维护成本翻倍 | 高 | 本月决策 |
| 伪流式 AI | 用户体验差 | 中 | 本周 |
| 词汇本无 SRS | 学习效率低 | 中 | 本月 |
| 缺少测试 | 回归风险高 | 高 | 本月 |
| 全局异常信息泄露 | 安全风险 | 极低 | 立即 |
| 状态管理混乱 | 维护困难 | 中 | 本月 |
| 后端单体路由 | 扩展性差 | 高 | 3 个月 |
| 字典缓存无过期 | 数据陈旧 | 低 | 本周 |
| 无离线支持 | 网络依赖 | 高 | 3 个月 |

---

## 八、附录：关键代码定位

| 文件 | 路径 | 关注行号 | 问题 |
|------|------|----------|------|
| `App.tsx` | `english-learning-web/src/App.tsx` | 12-69 | 硬编码演示数据 |
| `playerStore.ts` | `english-learning-web/src/stores/playerStore.ts` | 22-111 | 播放状态竞态（已部分修复） |
| `VideoPlayer.tsx` | `english-learning-web/src/components/VideoPlayer/VideoPlayer.tsx` | 33-128 | 事件监听/全屏切换逻辑 |
| `useSentenceShadowing.ts` | `english-learning-web/src/hooks/useSentenceShadowing.ts` | 14-59 | 逐句复读时序 Bug |
| `ai.ts` | `english-learning-web/src/api/ai.ts` | 86-104 | 伪流式实现 |
| `vocabulary.py` | `shadow-reader/backend/services/vocabulary.py` | 1-228 | 单文件 JSON 存储 |
| `main.py` | `shadow-reader/backend/main.py` | 59-71 | 异常信息泄露 |
| `shadow.js` | `shadow-reader/frontend/js/shadow.js` | 1-171 | 原生版影子跟读（功能更完整） |
| `VocabularyPanel.tsx` | `english-learning-web/src/components/VocabularyPanel/VocabularyPanel.tsx` | 1-154 | 无词汇列表展示 |

---

**文档版本：** v1.0  
**生成时间：** 2026-07-03
