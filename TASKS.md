# Shadow Reader 修复任务清单

> 本文档由 2026-07-05 产品/UX 深度审计生成，用于 `/loop` 循环修复。
> 每条任务独立可验收，按优先级排列。

## 图例

- `[ ]` 未开始
- `[~]` 进行中
- `[x]` 已完成

---

## P0 - 严重功能缺陷（影响核心可用性）

### P0-1: 修复 AI 聊天流式接口 404

**问题：**
前端 `src/api/ai.ts` 调用 `POST /api/ai/chat/stream`，但后端 `backend/main.py` 只有 `POST /api/ai/chat`。AI 助手聊天实际不可用。

**涉及文件：**
- `english-learning-web/src/api/ai.ts`
- `english-learning-web/src/components/AIPanel/ChatMode.tsx`
- `backend/main.py`
- `backend/services/ai_service.py`

**验收标准：**
- [x] 后端新增 `POST /api/ai/chat/stream` SSE 流式接口，或前端改为调用非流式 `/api/ai/chat`
- [x] 聊天消息能正常发送和接收
- [x] 流式输出时文字逐字显示，不卡顿
- [x] 网络错误时给出中文提示，不白屏

---

### P0-2: 修复本地文件历史记录无法重放

**问题：**
上传本地视频时，`videoUrl` 使用 `URL.createObjectURL(pendingFile)` 生成临时内存 URL。历史记录只保存文件名，刷新后或从历史记录进入时无法播放。

**涉及文件：**
- `english-learning-web/src/components/WelcomeScreen/WelcomeScreen.tsx`
- `english-learning-web/src/App.tsx`
- `english-learning-web/src/api/content.ts`
- `backend/main.py`（历史记录相关接口）

**验收标准：**
- [x] 本地文件上传后，在历史记录中点击能重新加载并播放
- [x] 关闭浏览器再打开，历史记录中的本地文件仍可播放（使用 IndexedDB 缓存文件，或提示用户重新选择文件）
- [x] YouTube/在线链接的历史记录播放不受影响

---

### P0-3: 修复 YouTube 视频无法播放

**问题：**
前端把 YouTube URL 直接塞进 HTML5 `<video>` 标签。YouTube 有 CORS/DRM 限制，无法直接播放。

**涉及文件：**
- `english-learning-web/src/components/VideoPlayer/VideoPlayer.tsx`
- `english-learning-web/src/types/player.ts`
- `english-learning-web/src/components/WelcomeScreen/WelcomeScreen.tsx`

**验收标准：**
- [x] YouTube 链接加载字幕后，视频能正常播放
- [x] 优先使用 YouTube IFrame API 嵌入播放器
- [x] 非 YouTube 的直接 MP4 链接保持现有播放方式
- [x] 播放器控制（播放/暂停/进度/倍速）对 YouTube 嵌入也能生效，或给出明确降级提示

---

### P0-4: 修复后端静态资源路径错误

**问题：**
`backend/main.py` 挂载静态文件到 `../frontend`，但前端目录实际是 `english-learning-web`。

**涉及文件：**
- `backend/main.py`

**验收标准：**
- [x] 生产构建后（`npm run build`），访问 `http://localhost:8000/` 能正确加载前端页面
- [x] 静态资源路径指向 `english-learning-web/dist`
- [x] 如果构建目录不存在，给出清晰的启动提示

---

### P0-5: 修复全局异常处理泄露 traceback

**问题：**
`backend/main.py` 的全局异常处理器把 traceback 返回给浏览器，既危险又对用户不友好。

**涉及文件：**
- `backend/main.py`

**验收标准：**
- [x] 生产环境不返回 traceback 给前端
- [x] 业务错误（如文件过大、模型未就绪）返回友好的中文 message
- [x] 系统错误记录完整日志到服务端，前端只显示"服务异常，请稍后重试"

---

### P0-6: 修复进度保存过于频繁

**问题：**
`App.tsx` 在每次渲染时都会启动 5 秒定时器保存进度，导致大量重复网络请求。

**涉及文件：**
- `english-learning-web/src/App.tsx`

**验收标准：**
- [x] 进度保存使用防抖（debounce），例如用户停止操作 5 秒后再保存
- [x] 切换视频或关闭页面时触发一次最终保存
- [x] 网络请求数量明显减少（可用浏览器 DevTools 验证）

---

## P1 - 核心体验优化（用户高频痛点）

### P1-1: 翻译分批 + 实时进度 + 取消按钮

**问题：**
翻译一次性提交全部句子，用户进入全屏黑屏等待，无法取消，无进度感知。

**涉及文件：**
- `english-learning-web/src/components/Toolbar/ToolBar.tsx`
- `english-learning-web/src/api/content.ts`
- `english-learning-web/src/stores/subtitleStore.ts`
- `backend/main.py`（`/api/translate-subtitles`）

**验收标准：**
- [x] 长视频翻译拆分为每批 20-30 句
- [x] 每完成一批立即更新对应字幕，用户可看到渐进结果
- [x] 显示翻译进度：`已翻译 45 / 200 句`
- [x] 提供取消按钮，取消后已翻译部分保留
- [x] 翻译失败时，成功部分保留，失败部分可单独重试

---

### P1-2: 优化自动滚动体验

**问题：**
字幕列表自动滚动过于敏感，用户手动滚动时会被强制拉回；`smooth` 动画与高频切换冲突导致抽搐。

**涉及文件：**
- `english-learning-web/src/components/SubtitlePanel/SubtitleList.tsx`
- `english-learning-web/src/stores/subtitleStore.ts`
- `english-learning-web/src/components/SubtitleSettings/SubtitleSettingsPanel.tsx`

**验收标准：**
- [ ] 检测用户手动滚动，3 秒内暂停自动滚动
- [ ] 当前句已在视口内时不滚动
- [ ] 自动滚动使用即时定位（`behavior: 'auto'`），手动跳转使用平滑滚动
- [ ] 用户滚动远离当前句时，显示"回到当前句"浮动按钮
- [ ] 设置中增加选项：自动滚动 / 仅高亮 / 关闭

---

### P1-3: 修复字幕与视频声音不同步

**问题：**
ASR 时间戳存在误差，加上前端 `timeupdate` 刷新频率低，字幕与口型/声音有延迟。

**涉及文件：**
- `english-learning-web/src/hooks/useSubtitleSync.ts`
- `english-learning-web/src/components/VideoPlayer/VideoPlayer.tsx`
- `english-learning-web/src/components/SubtitleSettings/SubtitleSettingsPanel.tsx`
- `backend/services/subtitle.py`
- `backend/services/asr.py`

**验收标准：**
- [x] 字幕设置面板增加"字幕偏移 ±2 秒"滑块，实时生效
- [x] 当前句判定增加前向预测，倍速播放时更稳定
- [x] 优先使用 `requestVideoFrameCallback` 替代 `timeupdate`（在不支持的浏览器降级）
- [~] 后端减少分块导致的累积漂移（用 VAD 锚点做全局校准）
- [x] 单句可微调时间轴（右键菜单：提前/延后 0.2s）

---

### P1-4: 隐藏/禁用未实现按钮

**问题：**
工具栏"自动分段"和"编辑"按钮点击后弹出"暂不支持"，损害信任。

**涉及文件：**
- `english-learning-web/src/components/Toolbar/ToolBar.tsx`

**验收标准：**
- [x] 未实现的功能按钮隐藏或置灰
- [x] 或实现真实功能后再显示
- [x] 不再出现 `alert('该功能暂不支持')`

---

### P1-5: 修复 `/api/transcribe/test` 405 错误

**问题：**
前端 `testASR()` 使用 GET 请求，但后端该接口只接受 POST，导致欢迎页 ASR 状态检测失败。

**涉及文件：**
- `english-learning-web/src/api/content.ts`
- `backend/main.py`

**验收标准：**
- [x] 前端改为 POST 请求，或后端同时支持 GET
- [x] 欢迎页正确显示 ASR 就绪状态
- [x] ASR 未就绪时给出清晰引导

---

### P1-6: 播放 AI 生成的语音回复

**问题：**
后端 AI 每次回复都生成 TTS 音频，但前端从不播放，浪费 token 和等待时间。

**涉及文件：**
- `english-learning-web/src/components/AIPanel/ChatMode.tsx`
- `english-learning-web/src/components/AIPanel/ExamMode.tsx`
- `english-learning-web/src/components/AIPanel/ExplainMode.tsx`
- `english-learning-web/src/api/ai.ts`

**验收标准：**
- [x] AI 回复的文字旁显示播放按钮
- [x] 点击后播放后端返回的 base64 音频
- [x] 提供"自动朗读回复"开关
- [x] 没有 DashScope key 时隐藏播放按钮

---

## P2 - 产品闭环与高级功能

### P2-1: 字幕数据模型支持多语言

**问题：**
`SubtitleCue` 只有 `secondaryText`，切换目标语言会覆盖，无法同时保留多语言。

**涉及文件：**
- `english-learning-web/src/types/subtitle.ts`
- `english-learning-web/src/stores/subtitleStore.ts`
- `english-learning-web/src/components/Toolbar/ToolBar.tsx`
- `english-learning-web/src/components/VideoPlayer/SubtitleOverlay.tsx`
- `backend/main.py`（历史记录保存）

**验收标准：**
- [x] `SubtitleCue` 改为 `translations: Record<lang, string>`
- [x] 切换目标语言时，如果已存在翻译则即时显示，无需重新请求
- [x] 历史记录保存和恢复多语言翻译
- [x] 向后兼容旧数据（`zh` 字段迁移到 `translations`）

---

### P2-2: 移动端/平板端支持词汇和搜索面板

**问题：**
`MobileLayout` 和 `TabletLayout` 只支持 `subtitles` 和 `ai` 面板，工具栏点击"词汇"/"查找"无反应。

**涉及文件：**
- `english-learning-web/src/components/Layout/MobileLayout.tsx`
- `english-learning-web/src/components/Layout/TabletLayout.tsx`
- `english-learning-web/src/components/Layout/PanelTabs.tsx`

**验收标准：**
- [x] 移动端底部 tab 增加"词汇"和"搜索"
- [x] 工具栏点击"词汇"/"查找"在所有布局下都能打开对应面板
- [x] 面板切换不破坏当前播放状态

---

### P2-3: 实现跟读录音与对比

**问题：**
产品名为 Shadow Reader，但缺少用户录音和跟读反馈。

**涉及文件：**
- `english-learning-web/src/components/StudyTools/StudyToolsBar.tsx`
- `english-learning-web/src/hooks/useSentenceShadowing.ts`
- `english-learning-web/src/components/VideoPlayer/PlayerControls.tsx`

**验收标准：**
- [x] 当前句播放后，自动开始录音（可开关）
- [x] 用户录音后可回放自己的发音
- [x] 显示原音和用户录音的波形对比（简单版）
- [x] 录音数据本地存储，可删除

---

### P2-4: 生词本 SRS 复习

**问题：**
生词本只是列表，没有间隔重复复习机制。

**涉及文件：**
- `english-learning-web/src/components/VocabularyPanel/VocabularyPanel.tsx`
- `english-learning-web/src/api/vocabulary.ts`
- `backend/services/vocabulary.py`
- `backend/main.py`

**验收标准：**
- [x] 每个单词记录熟练度/复习次数/下次复习时间
- [x] 提供复习模式（中英选择、拼写、听音辨词）
- [x] 到达复习时间的单词有提醒/红点
- [x] 复习结果更新熟练度

---

### P2-5: 支持导出字幕和生词表

**问题：**
用户无法导出自己的学习数据。

**涉及文件：**
- `english-learning-web/src/components/Toolbar/ToolBar.tsx`
- `english-learning-web/src/components/VocabularyPanel/VocabularyPanel.tsx`
- `english-learning-web/src/api/content.ts`
- `backend/main.py`

**验收标准：**
- [x] 可导出当前字幕为 SRT / VTT 文件
- [x] 可导出双语字幕（包含当前目标语言翻译）
- [x] 可导出生词本为 CSV / Anki 格式
- [x] 导出按钮在对应面板中可见

---

## P3 - 工程与可维护性

### P3-1: 为 AIPanelContent 添加错误边界

**涉及文件：**
- `english-learning-web/src/components/AIPanel/AIPanelContent.tsx`

**验收标准：**
- [x] AI 面板子组件崩溃时不影响整个应用
- [x] 显示"AI 助手出错"和重试按钮

---

### P3-2: 替换手写的 markdown 渲染

**问题：**
`MessageBubble.tsx` 使用 `dangerouslySetInnerHTML` 渲染 markdown，有 XSS 风险。

**涉及文件：**
- `english-learning-web/src/components/AIPanel/MessageBubble.tsx`

**验收标准：**
- [x] 使用 `react-markdown` 渲染 AI 回复
- [x] 代码块有样式高亮
- [x] 不引入 XSS 风险

---

### P3-3: 移除未使用的依赖

**问题：**
`video.js` 已安装但未使用，增加包体积。

**涉及文件：**
- `english-learning-web/package.json`

**验收标准：**
- [x] 移除 `video.js` 和 `@types/video.js`（如果确认不使用）
- [x] 构建产物体积减小
- [x] 不影响现有功能

---

## 附录：/loop 使用建议

1. 每次 `/loop` 选择 1 个 P0 或 1-2 个 P1 任务执行
2. 执行后更新本文件对应任务的 `[ ]` 为 `[x]`
3. 每个任务完成后运行相关功能验证
4. 不要一次性修改超过 3 个不相关文件，便于回滚

---

**文档版本：** v1.0  
**生成时间：** 2026-07-05  
**基于代码版本：** Shadow Reader v0.2.0
