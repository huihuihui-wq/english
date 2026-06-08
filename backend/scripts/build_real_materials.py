"""
真实英语素材生成器：用 edge-tts (Microsoft Azure Neural) 生成 mp3 + SRT

用法：
  python scripts/build_real_materials.py

需要：pip install edge-tts
生成两个目录：
  - backend/data/materials/static/  内置库（5 个）
  - backend/data/materials/daily/YYYY-MM-DD/  每日更新（5 个）
"""
import json
import re
import subprocess
import shutil
import sys
import tempfile
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "data" / "materials" / "static"
DAILY_PARENT = ROOT / "data" / "materials" / "daily"

# 临时目录（避开中文路径）
TTS_TMP = Path(tempfile.mkdtemp(prefix="tts_", dir="C:/Users/liurf1/AppData/Local/Temp"))


# === 内置库素材（5 段，固定） ===
STATIC_MATERIALS = [
    {
        "id": "news-ai-2026",
        "title": "AI and Daily Life",
        "description": "AI 改变日常生活的报道（慢速 0.9x）",
        "category": "Tech",
        "difficulty": "intermediate",
        "speed": 0.9,
        "icon": "AI",
        "color": "#4f8cff",
        "voice": "en-US-ChristopherNeural",
        "text": (
            "Good evening. Tonight, we explore how artificial intelligence is quietly transforming our daily routines. "
            "From the moment you wake up, AI is already at work. Your phone's face recognition, your news feed, even your coffee maker's timer. "
            "Voice assistants help millions of households manage schedules, play music, and control smart home devices. "
            "But experts warn this is just the beginning. In the next decade, AI will reshape how we work, learn, and connect. "
            "The challenge? Learning to use these powerful tools wisely, while keeping our human judgment at the center of every decision."
        ),
    },
    {
        "id": "news-climate-2026",
        "title": "Climate and Cities",
        "description": "城市气候适应报道（标准 1x）",
        "category": "News",
        "difficulty": "intermediate",
        "speed": 1.0,
        "icon": "NEWS",
        "color": "#4ade80",
        "voice": "en-US-MichelleNeural",
        "text": (
            "Good morning. Cities worldwide are facing unprecedented climate challenges. "
            "Rising temperatures, stronger storms, and extended heat waves are becoming the new normal. "
            "In response, urban planners are reimagining public spaces. Green rooftops, tree-lined boulevards, and cool pavements are replacing concrete jungles. "
            "Singapore's Gardens by the Bay and Milan's Vertical Forest are leading examples. "
            "These innovations are not merely about comfort. They save lives, slash energy consumption, and make cities more livable for generations to come."
        ),
    },
    {
        "id": "story-fox-grapes",
        "title": "The Fox and the Grapes",
        "description": "伊索寓言·狐狸与葡萄（慢速 0.8x）",
        "category": "Story",
        "difficulty": "beginner",
        "speed": 0.8,
        "icon": "FOX",
        "color": "#ffb84d",
        "voice": "en-GB-SoniaNeural",
        "text": (
            "Once upon a time, on a scorching summer day, a clever fox was wandering through an orchard. "
            "He spotted a beautiful bunch of ripe grapes hanging high upon a vine. "
            "The grapes looked wonderfully sweet and juicy, just perfect for a thirsty fox. "
            "He crouched down and leaped with all his might, but the grapes remained far beyond his reach. "
            "He tried again and again, yet each attempt ended in failure. "
            "Finally, the fox turned away with his nose in the air, muttering to himself, those grapes are probably sour anyway. "
            "And so, it is easy to despise what you cannot have."
        ),
    },
    {
        "id": "story-lion-mouse",
        "title": "The Lion and the Mouse",
        "description": "伊索寓言·狮子与老鼠（标准 1x）",
        "category": "Story",
        "difficulty": "beginner",
        "speed": 1.0,
        "icon": "LION",
        "color": "#a78bfa",
        "voice": "en-US-JennyNeural",
        "text": (
            "In a sun-drenched African savanna, a mighty lion was sleeping peacefully beneath an acacia tree. "
            "A tiny field mouse scampered across his massive paw, accidentally waking the king of beasts. "
            "The lion's eyes snapped open, and he trapped the trembling mouse beneath his enormous paw. "
            "Please, oh great lion, squeaked the mouse, spare my life, and one day I shall repay your kindness. "
            "The lion roared with laughter at such an absurd promise, but in a generous mood, he released the tiny creature. "
            "Days later, hunters trapped the lion in a sturdy rope net. His mighty roars echoed across the plains, but the ropes held firm. "
            "The little mouse heard his desperate cries and immediately began gnawing through the thick ropes with her sharp teeth. "
            "Within minutes, the lion was free. No act of kindness, no matter how small, is ever wasted."
        ),
    },
    {
        "id": "vo-tech-ai-2026",
        "title": "How AI Learns",
        "description": "AI 学习原理纪录片旁白（快速 1.2x）",
        "category": "Tech",
        "difficulty": "advanced",
        "speed": 1.2,
        "icon": "ML",
        "color": "#f472b6",
        "voice": "en-US-EricNeural",
        "text": (
            "How does artificial intelligence actually learn? At its core lies a surprisingly simple concept. "
            "You feed a neural network millions of examples, and it discovers hidden patterns within the data. "
            "For large language models, these examples are sentences drawn from books, websites, and academic papers. "
            "With each prediction, the model measures its error and makes microscopic adjustments to billions of parameters. "
            "Round after round, through countless iterations, the model grows increasingly fluent and capable. "
            "But let us be clear. This is not magic. It is mathematics, elegantly scaled to unprecedented proportions."
        ),
    },
]


# === 每日更新素材（5 段） ===
DAILY_MATERIALS = [
    {
        "id": "daily-monday",
        "title": "Monday Briefing",
        "description": "每日简报：今日要闻（标准 1x）",
        "category": "Daily",
        "difficulty": "intermediate",
        "speed": 1.0,
        "icon": "MON",
        "color": "#4f8cff",
        "voice": "en-US-GuyNeural",
        "text": (
            "Good morning and welcome to your Monday briefing. "
            "Markets opened higher today, driven by strong quarterly earnings in the technology sector. "
            "In science news, researchers announced a breakthrough in solid-state battery technology, which could make electric vehicles cheaper and significantly extend their range. "
            "And in sports, the home team advanced to the conference finals after a thrilling overtime victory. "
            "That is all for now. Have a productive week ahead."
        ),
    },
    {
        "id": "daily-quote",
        "title": "Words of Wisdom",
        "description": "每日金句：马克·吐温名言（慢速 0.85x）",
        "category": "Daily",
        "difficulty": "beginner",
        "speed": 0.85,
        "icon": "Q",
        "color": "#4ade80",
        "voice": "en-US-AriaNeural",
        "text": (
            "Today's wisdom comes from the great American writer Mark Twain. "
            "Twenty years from now, you will be more disappointed by the things you did not do, than by the things you did. "
            "So throw off the bowlines. Sail away from the safe harbor. "
            "Catch the trade winds in your sails. Explore. Dream. Discover. "
            "Words to live by, for today and every day."
        ),
    },
    {
        "id": "daily-sci",
        "title": "A Quick Science Fact",
        "description": "每日科学：闪电小知识（标准 1x）",
        "category": "Daily",
        "difficulty": "intermediate",
        "speed": 1.0,
        "icon": "SCI",
        "color": "#ffb84d",
        "voice": "en-GB-RyanNeural",
        "text": (
            "Did you know that a single bolt of lightning is approximately five times hotter than the surface of the sun? "
            "It can reach staggering temperatures of thirty thousand degrees Celsius. "
            "And every single second, roughly one hundred lightning strikes hit our planet. "
            "Most occur over land in warm, humid regions near the equator. "
            "So the next time you witness a thunderstorm, remember, you are watching one of nature's most extraordinary displays of raw power."
        ),
    },
    {
        "id": "daily-lifehack",
        "title": "English Learning Tip",
        "description": "每日技巧：影子跟读法（标准 1x）",
        "category": "Daily",
        "difficulty": "intermediate",
        "speed": 1.0,
        "icon": "TIP",
        "color": "#a78bfa",
        "voice": "en-US-EmmaNeural",
        "text": (
            "Today's language learning tip is about mastering English through active listening. "
            "Try the shadowing technique. Play a short audio clip and listen carefully. "
            "Then repeat what you hear immediately, matching the speaker's rhythm, intonation, and speed. "
            "Start slowly with simple materials, then gradually increase the difficulty and pace. "
            "Practice this for just ten minutes every single day, and your pronunciation and fluency will improve faster than you ever imagined."
        ),
    },
    {
        "id": "daily-news-tech",
        "title": "Tech Industry Update",
        "description": "每日科技：行业动态（快速 1.2x）",
        "category": "Daily",
        "difficulty": "advanced",
        "speed": 1.2,
        "icon": "TECH",
        "color": "#f472b6",
        "voice": "en-US-BrianNeural",
        "text": (
            "The technology industry continues to evolve at breakneck speed. "
            "Open source artificial intelligence models are now challenging proprietary systems, giving developers unprecedented freedom and flexibility. "
            "Meanwhile, edge computing is bringing powerful AI directly to consumer devices, dramatically reducing latency and enhancing privacy protection. "
            "Regulators worldwide are scrambling to keep pace with this rapid innovation, drafting new frameworks for AI governance and data security. "
            "One thing is abundantly clear. The next two years will fundamentally reshape how we build, deploy, and interact with software."
        ),
    },
]


def check_edge_tts():
    if not shutil.which("edge-tts"):
        print("ERROR: edge-tts not found. Install: pip install edge-tts")
        sys.exit(1)


def run_tts(text: str, out_mp3: Path, voice: str = "en-US-JennyNeural", rate: str = "+0%") -> bool:
    """调用 edge-tts 生成 mp3 + vtt，避开中文路径问题"""
    tmp_mp3 = TTS_TMP / (out_mp3.stem + ".mp3")
    tmp_vtt = TTS_TMP / (out_mp3.stem + ".vtt")
    
    for f in [tmp_vtt, tmp_mp3]:
        if f.exists():
            f.unlink()
    
    try:
        cmd = [
            "edge-tts",
            "--voice", voice,
            "--text", text,
            f"--rate={rate}",
            "--write-media", str(tmp_mp3),
            "--write-subtitles", str(tmp_vtt),
        ]
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
        )
        
        if result.returncode != 0:
            print(f"  TTS FAILED: {result.stderr[:300]}")
            return False
        
        if not tmp_mp3.exists():
            print(f"  TTS: mp3 not created")
            return False
            
        out_mp3.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(tmp_mp3, out_mp3)
        
        # Copy VTT if generated, otherwise we'll create from audio duration
        if tmp_vtt.exists():
            shutil.copy2(tmp_vtt, out_mp3.with_suffix(".vtt"))
        
        for f in [tmp_mp3, tmp_vtt]:
            if f.exists():
                f.unlink()
        
        return True
        
    except subprocess.TimeoutExpired:
        print(f"  TTS timeout")
        return False
    except Exception as e:
        print(f"  TTS error: {e}")
        return False


def parse_vtt(vtt_path: Path) -> list:
    """解析 edge-tts 生成的 VTT 字幕，返回句子列表"""
    if not vtt_path.exists():
        return []
    
    content = vtt_path.read_text(encoding="utf-8")
    # 去掉 WEBVTT 头
    lines = content.strip().split("\n")
    while lines and lines[0].strip() in ("WEBVTT", ""):
        lines.pop(0)
    
    subs = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        # 找时间行
        if "-->" in line:
            times = line.split("-->")
            if len(times) == 2:
                start = times[0].strip()
                end = times[1].strip()
                # 读取文本行
                text_lines = []
                i += 1
                while i < len(lines) and lines[i].strip() and "-->" not in lines[i]:
                    text_lines.append(lines[i].strip())
                    i += 1
                if text_lines:
                    subs.append({
                        "start": vtt_time_to_sec(start),
                        "end": vtt_time_to_sec(end),
                        "en": " ".join(text_lines),
                    })
                continue
        i += 1
    
    return subs


def vtt_time_to_sec(t: str) -> float:
    """00:00:02,500 -> 2.5"""
    t = t.strip()
    # 处理可能带空格的情况
    if " " in t:
        t = t.split()[0]
    
    match = re.match(r"(\d+):(\d+):(\d+)[,.](\d+)", t)
    if match:
        h, m, s, ms = match.groups()
        return int(h) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0
    return 0.0


def format_srt_time(sec: float) -> str:
    """秒 -> 00:00:00,000"""
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int((sec - int(sec)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(subs: list, out_path: Path):
    """写入 SRT 文件"""
    lines = []
    for i, sub in enumerate(subs, 1):
        lines.append(str(i))
        lines.append(f"{format_srt_time(sub['start'])} --> {format_srt_time(sub['end'])}")
        lines.append(sub["en"])
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def split_sentences(text: str) -> list:
    """按 .!? 切分句子"""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def get_audio_duration(mp3_path: Path) -> float:
    """使用 ffprobe 或 mutagen 获取音频时长"""
    try:
        # 尝试使用 mutagen
        from mutagen.mp3 import MP3
        audio = MP3(str(mp3_path))
        return audio.info.length
    except Exception:
        pass
    
    # 备用：用 ffprobe
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(mp3_path)],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception:
        pass
    
    return 0.0


def proportional_split_subs(duration: float, sentences: list) -> list:
    """按字符数比例分配时间戳"""
    if not sentences or duration <= 0:
        return []
    
    weights = [max(1, len(s)) for s in sentences]
    total_w = sum(weights)
    cursor = 0.0
    out = []
    
    for s, w in zip(sentences, weights):
        dur = duration * (w / total_w)
        out.append({
            "start": round(cursor, 2),
            "end": round(min(cursor + dur, duration), 2),
            "en": s,
        })
        cursor += dur
    
    return out


def build_material(mat: dict, out_dir: Path, date_str: str = None) -> dict | None:
    """为单条素材生成音频+字幕，返回 manifest 条目"""
    work = out_dir / mat["id"]
    work.mkdir(parents=True, exist_ok=True)
    audio_path = work / "audio.mp3"
    
    # 根据 speed 调整 rate 参数
    speed = mat.get("speed", 1.0)
    if speed == 1.0:
        rate = "+0%"
    elif speed < 1.0:
        rate = f"-{int((1 - speed) * 100)}%"
    else:
        rate = f"+{int((speed - 1) * 100)}%"
    
    print(f"\n[GEN] {mat['title']} (voice={mat.get('voice', 'en-US-JennyNeural')}, rate={rate})")
    
    if not run_tts(
        mat["text"], 
        audio_path, 
        mat.get("voice", "en-US-JennyNeural"),
        rate
    ):
        return None
    
    # 获取音频时长
    duration = get_audio_duration(audio_path)
    
    # 尝试解析 VTT 字幕
    vtt_path = audio_path.with_suffix(".vtt")
    subs = []
    
    if vtt_path.exists():
        vtt_subs = parse_vtt(vtt_path)
        if vtt_subs:
            subs = vtt_subs
            duration = subs[-1]["end"] if subs else duration
    
    # 如果 VTT 解析失败，用比例拆分
    if not subs:
        sentences = split_sentences(mat["text"])
        subs = proportional_split_subs(duration, sentences)
    
    # 写入 SRT
    if subs:
        write_srt(subs, work / "subtitles.srt")
    
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
    }
    if date_str:
        manifest["date"] = date_str
        manifest["source"] = "Daily Generated"
    
    print(f"  [OK] {mat['title']} ({duration:.1f}s, {len(subs)} subs)")
    return manifest


def merge_manifest(static_items: list, daily_items: list, date_str: str):
    """合并到 static/manifest.json"""
    manifest_path = STATIC_DIR / "manifest.json"
    
    # 合并所有素材
    all_items = static_items + daily_items
    
    manifest = {
        "materials": all_items,
        "updated": date_str,
        "note": "Real materials generated with Microsoft Azure Neural TTS (edge-tts)",
        "total": len(all_items),
    }
    
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n[MANIFEST] {manifest_path} ({len(all_items)} total)")


def main():
    check_edge_tts()
    
    print("=" * 60)
    print("Building REAL materials with edge-tts (Azure Neural Voices)")
    print("=" * 60)
    
    # 清理旧数据
    if STATIC_DIR.exists():
        shutil.rmtree(STATIC_DIR)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    
    # 1. 内置库
    print("\n>>> Static library materials")
    static_items = []
    for mat in STATIC_MATERIALS:
        item = build_material(mat, STATIC_DIR)
        if item:
            static_items.append(item)
    
    # 2. 每日更新
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"\n>>> Daily materials ({today})")
    daily_dir = DAILY_PARENT / today
    if daily_dir.exists():
        shutil.rmtree(daily_dir)
    daily_dir.mkdir(parents=True, exist_ok=True)
    
    daily_items = []
    for mat in DAILY_MATERIALS:
        item = build_material(mat, daily_dir, date_str=today)
        if item:
            daily_items.append(item)
    
    # 3. 写 daily candidates.json
    daily_meta = daily_dir / "candidates.json"
    daily_meta.write_text(
        json.dumps({"date": today, "candidates": daily_items, "total": len(daily_items)},
                   ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n[DAILY] {daily_meta} ({len(daily_items)} items)")
    
    # 4. 合并 manifest
    merge_manifest(static_items, daily_items, today)
    
    # 5. 清理临时文件
    for f in TTS_TMP.glob("*"):
        f.unlink(missing_ok=True)
    TTS_TMP.rmdir()
    
    print("\n" + "=" * 60)
    print(f"[ALL DONE] Generated {len(static_items)} static + {len(daily_items)} daily materials")
    print("=" * 60)


if __name__ == "__main__":
    main()
