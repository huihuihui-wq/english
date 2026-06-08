"""
处理下载的真实视频，生成字幕并添加到素材库
"""
import asyncio
import json
import shutil
from pathlib import Path
import sys

# 添加 backend 到路径
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# 加载环境变量
from dotenv import load_dotenv
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

from services.asr import transcribe_audio
from services.translate import translate_sentences
from services.subtitle import split_sentences_with_timestamps

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "data" / "materials" / "static"
VIDEOS_DIR = Path("C:/tmp/videos")

MATERIALS = [
    {
        "id": "video-nasa-space",
        "title": "NASA: Space Race to the Moon",
        "description": "NASA 纪录片：太空竞赛（真实视频，2分钟剪辑）",
        "category": "Documentary",
        "difficulty": "intermediate",
        "speed": 1.0,
        "icon": "NASA",
        "color": "#1e40af",
        "audio_file": "nasa_2min.mp3",
        "video_file": "nasa_space_race.mp4",
    },
    {
        "id": "video-ted-education",
        "title": "TED-Ed: The Power of Education",
        "description": "TED-Ed 教育短片（真实视频，2分钟剪辑）",
        "category": "Education",
        "difficulty": "intermediate",
        "speed": 1.0,
        "icon": "TED",
        "color": "#e11d48",
        "audio_file": "ted_2min.mp3",
        "video_file": "ted_education.mp4",
    },
    {
        "id": "video-bbc-news",
        "title": "BBC Learning English: News Report",
        "description": "BBC 英语学习新闻报道（真实视频，2分钟剪辑）",
        "category": "News",
        "difficulty": "beginner",
        "speed": 1.0,
        "icon": "BBC",
        "color": "#b91c1c",
        "audio_file": "bbc_2min.mp3",
        "video_file": "news_bbc.mp4",
    },
]


def format_srt_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int((sec - int(sec)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(subs: list, out_path: Path):
    lines = []
    for i, sub in enumerate(subs, 1):
        lines.append(str(i))
        lines.append(f"{format_srt_time(sub['start'])} --> {format_srt_time(sub['end'])}")
        lines.append(sub["en"])
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


async def process_material(mat: dict) -> dict | None:
    """处理单个视频素材"""
    work_dir = STATIC_DIR / mat["id"]
    work_dir.mkdir(parents=True, exist_ok=True)
    
    audio_path = VIDEOS_DIR / mat["audio_file"]
    video_path = VIDEOS_DIR / mat["video_file"]
    
    if not audio_path.exists():
        print(f"  [SKIP] Audio not found: {audio_path}")
        return None
    
    print(f"\n[PROCESS] {mat['title']}")
    
    # 1. 复制音频和视频
    shutil.copy2(audio_path, work_dir / "audio.mp3")
    if video_path.exists():
        shutil.copy2(video_path, work_dir / "video.mp4")
    
    # 2. ASR 生成字幕
    try:
        audio_bytes = (work_dir / "audio.mp3").read_bytes()
        result = await transcribe_audio(audio_bytes, "audio.mp3", "audio/mpeg")
        
        text = result.get("text", "")
        words = result.get("words", [])
        duration_ms = result.get("duration_ms", 0)
        
        print(f"  ASR: {len(text)} chars, {len(words)} words, {duration_ms/1000:.1f}s")
        
        # 3. 分句（如果有词级时间戳就用，否则用比例分配）
        if words:
            subs = split_sentences_with_timestamps(words, text)
        else:
            # 没有词级时间戳，用比例分配
            import re
            sentences = re.split(r"(?<=[.!?])\s+", text.strip())
            sentences = [s.strip() for s in sentences if s.strip()]
            
            # 获取实际音频时长
            duration_sec = duration_ms / 1000 if duration_ms > 0 else 120.0
            
            # 如果 duration 为 0，用 ffprobe 获取
            if duration_sec <= 0:
                try:
                    import subprocess
                    result = subprocess.run(
                        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                         "-of", "default=noprint_wrappers=1:nokey=1", str(work_dir / "audio.mp3")],
                        capture_output=True, text=True, timeout=10
                    )
                    if result.returncode == 0:
                        duration_sec = float(result.stdout.strip())
                except Exception:
                    duration_sec = 120.0
            
            # 比例分配
            weights = [max(1, len(s)) for s in sentences]
            total_w = sum(weights)
            cursor = 0.0
            subs = []
            for s, w in zip(sentences, weights):
                dur = duration_sec * (w / total_w)
                subs.append({
                    "start": round(cursor, 2),
                    "end": round(cursor + dur, 2),
                    "en": s,
                })
                cursor += dur
        
        # 4. 翻译
        if subs:
            en_list = [s["en"] for s in subs]
            try:
                translations = await translate_sentences(en_list)
                for s, tr in zip(subs, translations):
                    s["zh"] = tr.get("zh", "")
                print(f"  Translated: {len(translations)} sentences")
            except Exception as e:
                print(f"  Translation failed: {e}")
                for s in subs:
                    s["zh"] = ""
        
        # 5. 写入 SRT
        write_srt(subs, work_dir / "subtitles.srt")
        
        duration = subs[-1]["end"] if subs else 120.0
        
        manifest = {
            "id": mat["id"],
            "title": mat["title"],
            "description": mat["description"],
            "category": mat["category"],
            "difficulty": mat["difficulty"],
            "speed": mat["speed"],
            "icon": mat["icon"],
            "color": mat["color"],
            "duration": round(duration, 2),
            "audio_url": f"/api/materials/{mat['id']}/audio",
            "srt_url": f"/api/materials/{mat['id']}/srt",
            "is_placeholder": False,
            "source": "Real Video",
            "has_video": (work_dir / "video.mp4").exists(),
        }
        
        print(f"  [OK] {mat['title']} ({duration:.1f}s, {len(subs)} subs)")
        return manifest
        
    except Exception as e:
        print(f"  [FAILED] {mat['title']}: {e}")
        return None


async def main():
    print("=" * 60)
    print("Processing real video materials")
    print("=" * 60)
    
    items = []
    for mat in MATERIALS:
        item = await process_material(mat)
        if item:
            items.append(item)
    
    # 更新 manifest
    manifest_path = STATIC_DIR / "manifest.json"
    existing = {"materials": []}
    if manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    
    # 合并，去重
    new_ids = {m["id"] for m in items}
    existing["materials"] = [
        m for m in existing.get("materials", [])
        if m.get("id") not in new_ids
    ] + items
    
    existing["updated"] = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).strftime("%Y-%m-%d")
    existing["note"] = "Real video materials from NASA, TED-Ed, BBC"
    existing["total"] = len(existing["materials"])
    
    manifest_path.write_text(
        json.dumps(existing, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    
    print(f"\n[MANIFEST] {manifest_path} ({len(existing['materials'])} total)")
    print(f"[DONE] Processed {len(items)} video materials")


if __name__ == "__main__":
    asyncio.run(main())
