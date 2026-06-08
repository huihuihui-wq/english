# BBC 每日素材接入指南

## 架构

```
┌────────────────────┐
│  GitHub Actions    │  ← 海外服务器，可访问 BBC
│  (每天 03:00 UTC)  │
└──────────┬─────────┘
           │ 1. crawl_bbc.py 拉取 BBC 索引页
           │ 2. 下载 mp3 / mp4
           │ 3. process_bbc.py:
           │      - ffmpeg 抽音
           │      - DashScope qwen3-asr-flash 转写
           │      - 比例切句（无词级时间戳时的回退）
           │      - Hunyuan-MT-7B 翻译
           │ 4. 写入 backend/data/materials/static/{id}/
           │ 5. 更新 manifest.json
           │ 6. git commit + push
           ▼
┌────────────────────┐
│  Your Server       │  ← 用户本地/自有服务器
│  (FastAPI)         │
│  GET /api/materials│
└──────────┬─────────┘
           │ 7. 前端 fetch → 渲染素材卡
           ▼
┌────────────────────┐
│  Browser           │
│  📚 内置库 / 🆕 每日  │
└────────────────────┘
```

## 启用步骤

### 1. 在 GitHub 仓库配置 Secrets

进入 `Settings → Secrets and variables → Actions → New repository secret`：

| Name | Value |
|---|---|
| `DASHSCOPE_API_KEY` | `sk-8a240109ce354ac5a68d4aedc04b624d` |
| `SILICONFLOW_API_KEY` | `sk-ncipavbbpvhdswrajvhmjkrnmlnmlzzebgdeoubmahveusde` |

### 2. 启用 Actions

- 推送到 `main` 分支
- 进入 `Actions` 标签 → 启用 workflows
- 工作流 `.github/workflows/daily-bbc.yml` 会自动按 cron 跑

### 3. 手动触发（首次）

- Actions → Daily BBC Materials → Run workflow
- 等 1-3 分钟，查看运行日志
- 成功后 backend/data/materials/static/ 会出现 bbc-YYYY-MM-DD-NN/ 目录

### 4. 前端查看

- 刷新 http://localhost:8000
- 切到"🆕 每日更新" tab
- 会显示最近抓取的 BBC 节目

## 故障排查

### Actions 跑失败

- 检查 Secrets 是否填对
- 查看 Actions 日志的 [crawl_bbc.py] 输出，确认 BBC 能访问
- BBC 页面结构可能变了 → 改 `crawl_bbc.py` 里的正则

### BBC 视频下载 404

- BBC 资源 URL 经常变
- 当前 `crawl_bbc.py` 优先用页面内嵌的 mp3 URL
- 如果没有，会用 slug 拼接 `https://downloads.bbc.co.uk/learningenglish/features/{slug}/{slug}.mp3`
- 这条经验 URL 不一定 100% 准确，可能需要适配

### 字幕错位

- 当前用"按字数比例分配"切句（因为 qwen3-asr-flash 不返回时间戳）
- 偏差 1-3 秒
- 如需"剪映级"精确度：升级到 fun-asr（需公网 URL 传 OSS）或本地跑 faster-whisper

## 手动添加自定义素材

不用爬虫也能添加素材：

```bash
# 1. 准备音频（如 my-favorite.mp3）和字幕（my-favorite.srt）
# 2. 创建目录
mkdir -p backend/data/materials/static/my-favorite

# 3. 放文件
cp my-favorite.mp3 backend/data/materials/static/my-favorite/audio.mp3
cp my-favorite.srt backend/data/materials/static/my-favorite/subtitles.srt

# 4. 编辑 backend/data/materials/static/manifest.json
# 在 materials 数组里加：
#   {
#     "id": "my-favorite",
#     "title": "My Favorite",
#     "description": "...",
#     "category": "自定义",
#     "difficulty": "intermediate",
#     "speed": 1.0,
#     "icon": "★",
#     "color": "#ff6b6b",
#     "duration": 60.0,
#     "audio_url": "/api/materials/my-favorite/audio",
#     "srt_url": "/api/materials/my-favorite/srt",
#     "is_placeholder": false
#   }

# 5. 重启后端服务
```

## 定时表

- **03:00 UTC** (= 北京时间 11:00) 抓取
- 失败不会阻塞（Actions 自动重试 3 次）
- 抓取失败时旧的素材继续可用

## 隐私

- BBC 素材版权归 BBC 所有，本项目仅作为学习用途
- 抓取的内容仅在公开网页可见
- 商用前请咨询 BBC
