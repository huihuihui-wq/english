# Shadow Reader · 影子跟读

一个**纯前端 + 后端 API** 的影子跟读工具。上传音频/视频，AI 自动转写并按句切分，配套中文翻译与时间轴，可控倍速、单句重读、自动跟读循环。

## ✨ 功能

- 📁 **拖入音视频**（mp3 / wav / m4a / mp4，≤50MB / ≤1h）
- 🤖 **AI 自动转写**（SiliconFlow `FunAudioLLM/SenseVoiceSmall`）
- 🌐 **逐句翻译**（SiliconFlow `tencent/Hunyuan-MT-7B`，WMT2025 30/31 赛道冠军）
- ⏱ **按句时间轴**（按标点切句 + 字符数等比分配）
- ⏯ **播放器**：倍速 0.5x ~ 2x / 单句跳转 / 进度条
- 🔁 **跟读模式**：每句重读 N 次（可调） + 句间停顿（可调）
- ⌨️ **快捷键**：Space / ← / → / R / 1-6 / 0
- 💾 **设置持久化**：localStorage

## 🛠 技术栈

| 层 | 选型 |
|---|---|
| 前端 | 纯 HTML + 原生 JS（无构建） |
| 后端 | Python 3.10+ / FastAPI / Uvicorn |
| ASR | SiliconFlow `FunAudioLLM/SenseVoiceSmall` |
| 翻译 | SiliconFlow `tencent/Hunyuan-MT-7B` |
| 时间戳 | 比例估算（按标点切句 + 字符数等比分配） |

## 🚀 快速开始

### Windows

```bat
run.bat
```

浏览器打开 http://localhost:8000

### macOS / Linux

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # 编辑填入 SILICONFLOW_API_KEY
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## ⚙️ 配置

`backend/.env`：

```env
SILICONFLOW_API_KEY=sk-xxxxxxxxxxxx
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
ASR_MODEL=FunAudioLLM/SenseVoiceSmall
TRANSLATE_MODEL=tencent/Hunyuan-MT-7B
MAX_UPLOAD_MB=50
```

> 申请 Key：https://cloud.siliconflow.cn/account/ak

## 📁 项目结构

```
shadow-reader/
├── backend/
│   ├── main.py              # FastAPI 入口
│   ├── services/
│   │   ├── asr.py           # SiliconFlow ASR
│   │   ├── translate.py     # Hunyuan-MT-7B 翻译
│   │   └── subtitle.py      # 切句 + 时间戳
│   ├── .env                 # API Key（勿提交）
│   ├── .env.example
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── app.js           # 主装配
│       ├── uploader.js      # 上传
│       ├── player.js        # 播放器
│       ├── shadow.js        # 跟读模式
│       └── storage.js       # localStorage
├── run.bat
└── README.md
```

## 📡 API

### `POST /api/transcribe`

请求：multipart/form-data，字段 `file`（音视频文件），可选 `duration`（秒，前端可从 metadata 传入更准）。

响应：

```json
{
  "duration": 124.5,
  "subtitles": [
    { "start": 0, "end": 4.2, "en": "Hi, I'd like to check in please.", "zh": "我想办理入住。" },
    { "start": 4.2, "end": 7.8, "en": "Do you have a reservation?", "zh": "您有预订吗？" }
  ],
  "raw_text": "..."
}
```

### `GET /api/health`

健康检查。

## ⚠️ 已知限制

- **时间戳为估算值**（按字符数等比），与真实断句可能偏差 1-3 秒。对跟读场景已足够使用。
- **单文件 ≤ 50MB / ≤ 1 小时**（SiliconFlow 限制）。
- **不支持视频字幕轨道抽取**（仅取音频流播放）。

## 🗺 路线图

- [ ] 接入本地强制对齐（whisperX / aeneas）替换比例估算
- [ ] PWA 离线壳
- [ ] 用户上传 SRT 字幕优先
- [ ] 学习记录与统计
