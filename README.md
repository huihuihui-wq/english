# Shadow Reader

AI-powered shadowing practice. Upload audio/video or paste a YouTube/direct video link, and Shadow Reader transcribes, splits by sentence, translates, and gives you a player built for sentence-level looping and shadowing.

## Features

- **Upload** audio/video (mp3 / wav / m4a / mp4, up to 200MB)
- **Paste a link** — YouTube or direct MP4/WebM
- **AI transcription** with DashScope `qwen3-asr-flash`
- **Sentence-level translations** with DashScope `qwen-plus` (Chinese, Japanese, Spanish, and more)
- **TTS test tab** with DashScope `sambert` voices — synthesize English/Chinese text and play/download audio
- **Adjustable speed** (0.5x–2x), sentence jumping, looping, pause gap
- **History** — saves subtitles and progress per video; re-uploading merges cached translations automatically
- **Local quota estimate** — helps track DashScope token usage
- **Keyboard shortcuts** — Space, ←/→, R, 1–6, 0

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Plain HTML + vanilla JS (no build step) |
| Backend | Python 3.10+ / FastAPI / Uvicorn |
| ASR | DashScope `qwen3-asr-flash` |
| Translation | DashScope `qwen-plus` |
| TTS | DashScope `sambert` |

## Quick start

### Windows

```bat
run.bat
```

Then open http://localhost:8000.

### macOS / Linux

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # edit and add DASHSCOPE_API_KEY
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Configuration

Create `backend/.env` from `.env.example`:

```env
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxx
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/api/v1
ASR_MODEL=qwen3-asr-flash
TRANSLATE_MODEL=qwen-plus
MAX_UPLOAD_MB=200
```

Get a free key at https://bailian.console.aliyun.com/?tab=model#/api-key.

## Project structure

```
shadow-reader/
├── backend/
│   ├── main.py                 # FastAPI entry
│   ├── services/
│   │   ├── asr.py              # DashScope ASR
│   │   ├── translate.py        # qwen-plus translation
│   │   ├── subtitle.py         # sentence splitting + timestamps
│   │   ├── youtube_subtitles.py# YouTube subtitle fetching
│   │   └── config.py           # settings persistence
│   ├── .env.example
│   └── requirements.txt
├── frontend/
│   ├── index.html
│   ├── css/style.css
│   └── js/                     # vanilla JS modules
├── run.bat
└── README.md
```

## API

- `POST /api/transcribe` — upload audio/video and get subtitles + translation
- `POST /api/generate-subtitles` — generate subtitles from a YouTube or direct video URL
- `POST /api/translate-subtitles` — translate a list of sentences
- `POST /api/tts` — synthesize text to speech
- `GET /api/tts/voices` — list available Sambert voices
- `GET /api/translate/info` — supported target languages
- `GET|POST /api/quota` — read/update local quota estimate
- `GET|POST|PATCH|DELETE /api/history/*` — history CRUD and progress
- `GET|POST /api/config` — read/update API key and settings

## License

MIT

## Notes

- **Audio duration limit**: `qwen3-asr-flash` has a model-level audio length limit. The default backend guard is **120 seconds (2 minutes)**. Longer uploads are automatically sliced into overlapping segments, transcribed in parallel, and merged with offset timestamps. If slicing still fails, trim the clip or increase `MAX_ASR_AUDIO_SECONDS` in `backend/.env` if your DashScope account supports longer audio.
- **Timing accuracy for long audio**: When ASR does not return word-level timestamps, the backend uses ffmpeg `silencedetect` to find real speech/non-speech regions and maps subtitles to actual voice segments. Non-speech segments (intro music, long pauses) are shown as `...` placeholder subtitles so the timeline stays aligned with the audio.
- Timestamps are estimated from ASR word timings and punctuation. They are good enough for shadowing but may drift 1–3 seconds from exact speech boundaries.
- Free DashScope quotas vary by account and promotion. The in-app quota widget is a local estimate; verify your actual balance in the DashScope console.
