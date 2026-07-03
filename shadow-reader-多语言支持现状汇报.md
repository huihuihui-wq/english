# Shadow Reader 多语言支持现状汇报

## 问题概述

**用户提问：** 现在只有英文可以识别吗？支持其他语言的识别吗？

**结论：** 语音识别（ASR）本身支持多语言，但围绕 ASR 的周边功能（单词级时间戳对齐、单词点击查词、自动翻译、句子分词）存在大量英语硬编码。非英语内容**可以识别出字幕**，但体验远低于英语。

---

## 1. 前端语言选择器

文件：`frontend/index.html` (第 45-56 行)

当前上传界面提供 10 种语言选项：

| value | 语言 |
|-------|------|
| en | English (默认) |
| zh | 中文 |
| ja | 日本語 |
| ko | 한국어 |
| es | Español |
| fr | Français |
| de | Deutsch |
| pt | Português |
| ru | Русский |
| it | Italiano |

> 该参数通过 `FormData` 传递到后端 `/api/transcribe` 接口。

---

## 2. 语音识别（ASR）能力 ✅ 支持多语言

文件：`backend/services/asr.py` (第 327-380 行)

| 项目 | 状态 | 说明 |
|------|------|------|
| 引擎 | faster-whisper | OpenAI Whisper 的优化实现 |
| 多语言支持 | ✅ **支持** | Whisper 原生支持 99 种语言，通过 `language` 参数引导解码 |
| 语言参数传递 | ✅ | `model.transcribe(wav_path, language=language if language else None)` |
| 长音频切分 | ✅ | 自动切分为 30s 窗口 + 500ms 重叠 |
| 词级时间戳 | ⚠️ 部分支持 | 见下文 wav2vec2 fallback 问题 |

**关键代码：**
```python
# asr.py 第 521-527 行
segments, info = model.transcribe(
    wav_path,
    language=language if language else None,  # ← 多语言引导
    task="transcribe",
    word_timestamps=True,
    vad_filter=True,
    condition_on_previous_text=True,
)
```

**结论：** 只要 Whisper 模型能加载，任何在 faster-whisper 支持列表内的语言都能被识别。上传中文/日语/韩语音频，同样可以生成字幕文本。

---

## 3. 词级时间戳 Fallback（wav2vec2 对齐）⚠️ 仅英语

文件：`backend/services/aligner.py` (第 49-50 行)

```python
SUPPORTED_LANGUAGES = {"en"}
```

| 项目 | 状态 | 说明 |
|------|------|------|
| 模型 | facebook/wav2vec2-base-960h | 纯英语训练 |
| 支持语言 | ❌ **仅英语** | 非英语直接返回 `None` |
| 非英语后果 | ⚠️ 回退到比例分配 | 句子级时间戳由 `subtitle.py` 的 `_fallback_proportional` 生成，精度远低于词级对齐 |

**关键代码：**
```python
# aligner.py 第 318-321 行
language = (language or "en").lower().split("-")[0]
if language not in SUPPORTED_LANGUAGES:
    logger.info("wav2vec2 CTC alignment not supported for language '%s'", language)
    return None
```

**影响：** 非英语音频的字幕时间戳只能做到**句子级别**，无法精确到单词级别。对于 Shadowing 跟读练习来说，这意味着无法精确定位某个词的发音区间。

---

## 4. 字幕数据结构：字段名硬编码为 `en`

文件：`backend/main.py` (第 98-105 行)

```python
class SubtitleItem(BaseModel):
    start: float
    end: float
    en: str        # ← 所有语言的源文本都存这里
    zh: str = ""   # ← 翻译字段
    source_lang: str = "en"  # ← 真实语言标记
    is_placeholder: bool = False
```

**问题：** 无论识别的是中文、日语还是俄语，字幕原文都存入 `en` 字段。虽然 `source_lang` 记录了真实语言，但字段命名本身具有英语中心性。前端代码（如 `player.js`）从 `s.en` 读取原文，如果未来需要真正支持多语言 UI，这里需要重构。

---

## 5. 前端单词点击查词 ❌ 仅英语

文件：`frontend/js/player.js` (第 595-619 行)

```javascript
const _WORD_RE = /[A-Za-z][A-Za-z'\-]*|[0-9]+|[^A-Za-z0-9\s]+|\s+/g;

function isEnglishWordToken(t) {
    if (!/^[A-Za-z]/.test(t)) return false;
    return /^[A-Za-z][A-Za-z'\-]*$/.test(t);
}

function renderWordsHtml(text) {
    // ... 只有匹配 isEnglishWordToken 的 token 才会生成 <span class="word"> ...
}
```

| 项目 | 状态 | 说明 |
|------|------|------|
| 正则匹配 | ❌ 仅 ASCII 字母 | `[A-Za-z]` 硬编码 |
| 中文/日语/韩语 | ❌ 无法点击 | 被当作 `word-punct` 渲染，无 `data-word` 属性 |
| 查词功能 | ❌ 英语专用 | `word-lookup.js` 和 `word_tokenize.py` 都是英语词典逻辑 |

**影响：** 非英语字幕的文本无法点击查词。对于中文/日语/韩语学习用户，这是核心功能缺失。

---

## 6. 后端单词处理 ❌ 英语专用

文件：`backend/services/word_tokenize.py`

| 项目 | 状态 | 说明 |
|------|------|------|
| 词形还原（Lemmatization） | ❌ 英语专用 | `_IRREGULAR` 字典只包含英语不规则动词/名词 |
| 词性判断 | ❌ 英语专用 | `is_english_word()` 只匹配 `[a-z][a-z0-9'\-_]*` |
| 分词正则 | ❌ 英语专用 | `_TOKEN_RE = r"[A-Za-z][A-Za-z'\-]*|..."` |

**影响：** 即使前端扩展了可点击单词，后端也无法为中文/日语/韩语提供正确的词形还原和词典查询。

---

## 7. 自动翻译 ❌ 仅英语触发

文件：`backend/main.py` (第 432-451 行)

```python
# Auto-translate only English source for now
if language == "en":
    translate_indices = [i for i, it in enumerate(items) if not it.get("is_placeholder")]
    en_list = [items[i]["en"] for i in translate_indices]
    # ... 调用 translate_sentences()
else:
    for it in items:
        it["zh"] = ""  # ← 非英语不翻译，zh 为空
```

**影响：** 只有英语源材料才会自动翻译成中文。如果上传的是日语/韩语/俄语音频，翻译字段为空，用户必须手动翻译或自行添加翻译。

---

## 8. 句子分词逻辑 ⚠️ 部分受限

文件：`backend/services/subtitle.py`

| 项目 | 状态 | 说明 |
|------|------|------|
| Whisper 段落边界 | ✅ 多语言 | 依赖 Whisper 的 `segment` 输出，本身支持多语言 |
| 词停顿分组 | ⚠️ 语言无关 | 基于时间间隔（`pause_threshold_ms=700`），不依赖语言 |
| 文本句子切分 | ⚠️ 可能受限 | `_split_text_to_sentences` 对非英语标点的处理可能不够精确 |

---

## 总结矩阵

| 功能 | 英语 | 中文/日语/韩语/其他 | 关键文件 |
|------|------|---------------------|----------|
| **语音识别（ASR）** | ✅ 完整 | ✅ **支持** | `asr.py` |
| **词级时间戳** | ✅ 精确（Whisper + wav2vec2） | ⚠️ 仅句子级（Whisper 无 wav2vec2 fallback） | `aligner.py` |
| **字幕显示** | ✅ 完整 | ✅ 文本可显示 | `player.js` |
| **单词点击查词** | ✅ 完整 | ❌ **不可用** | `player.js`, `word-lookup.js` |
| **单词词形还原** | ✅ 完整 | ❌ **不可用** | `word_tokenize.py` |
| **自动翻译** | ✅ 自动中译 | ❌ **不触发** | `main.py` |
| **TTS 发音** | ✅ 英语 voices | ⚠️ 取决于 TTS 服务 | `voice_service.py` |
| **历史记录保存** | ✅ 完整 | ✅ 可保存 | `history.js` |

---

## 核心结论

> **"可以识别，但不够好用。"**

1. **语音识别层面**：得益于 faster-whisper 的多语言能力，上传中文、日语、韩语等音频可以正确识别出文本字幕。这是当前架构下最不需要改动的一层。

2. **时间戳精度**：非英语音频缺少 wav2vec2 CTC 词级对齐 fallback，只能依赖 Whisper 的 segment 边界和比例分配，时间戳精度不如英语。

3. **学习体验层面**：单词点击查词、词形还原、自动翻译等核心功能均为英语硬编码。非英语用户无法享受"点击生词→即时查词→保存词汇本"的完整学习闭环。

4. **如果要支持多语言学习**：需要分别改造：
   - 前端 `renderWordsHtml` 的分词正则（中日韩分词需要 jieba/Mecab 等）
   - 后端 `word_tokenize.py` 的词形还原和词典查询
   - 后端 `aligner.py` 引入多语言 wav2vec2 模型（如 wav2vec2-xlsr-53）
   - 后端 `main.py` 自动翻译逻辑去掉 `language == "en"` 限制
   - 数据结构 `SubtitleItem.en` 字段的重命名或重构
