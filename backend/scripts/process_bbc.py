"""
BBC 素材处理：candidates.json -> 下载音频 -> ASR(时间戳) -> 翻译 -> 写素材目录

由 GitHub Actions 在海外环境调用。
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

ROOT = Path(__file__).resolve().parent.parent
DAILY_DIR = ROOT / "data" / "materials" / "daily"
STATIC_DIR = ROOT / "data" / "materials" / "static"


def http_download(url: str, out: Path, timeout: int = 60) -> bool:
    """下载文件到本地"""
    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=timeout) as resp:
            data = resp.read()
        out.write_bytes(data)
        return True
    except Exception as e:
        print(f"  [DOWNLOAD FAIL] {url}: {e}")
        return False


def extract_audio(video_path: Path, out_path: Path) -> bool:
    """从视频抽音轨"""
    if not video_path.exists():
        return False
    cmd = [
        "ffmpeg", "-y", "-i", str(video_path),
        "-vn", "-acodec", "libmp3lame",
        "-ac", "1", "-ar", "16000", "-b:a", "64k",
        str(out_path),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        return out_path.exists()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f"  [FFMPEG FAIL] {e}")
        return False


def seconds_to_srt_time(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = int(t % 60)
    ms = int((t - int(t)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def proportional_fallback(text: str, total_sec: float) -> list:
    """无词级时间戳时按比例分配"""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    parts = [p for p in parts if p.strip()]
    if not parts:
        return []

    weights = [max(1, len(p)) for p in parts]
    total = sum(weights)
    cursor = 0.0
    out = []
    for p, w in zip(parts, weights):
        dur = total_sec * (w / total)
        out.append({
            "start": cursor,
            "end": cursor + dur,
            "en": p,
        })
        cursor += dur
    return out


def transcribe_via_dashscope(audio_path: Path, api_key: str) -> dict:
    """调 DashScope qwen3-asr-flash 返回 text + duration_ms"""
    import base64
    import httpx

    data = audio_path.read_bytes()
    b64 = base64.b64encode(data).decode()
    data_uri = f"data:audio/mpeg;base64,{b64}"

    payload = {
        "model": "qwen3-asr-flash",
        "input": {
            "messages": [
                {"role": "system", "content": [{"text": ""}]},
                {"role": "user", "content": [{"audio": data_uri}]},
            ]
        },
        "parameters": {
            "asr_options": {"language": "en", "enable_itn": False},
        },
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    with httpx.Client(timeout=300) as client:
        resp = client.post(
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
            json=payload, headers=headers,
        )

    if resp.status_code != 200:
        return {"text": "", "duration_ms": 0, "error": resp.text[:200]}

    j = resp.json()
    try:
        text = j["output"]["choices"][0]["message"]["text"]
        return {"text": text, "duration_ms": 0}
    except (KeyError, IndexError) as e:
        return {"text": "", "duration_ms": 0, "error": str(e)}


def get_audio_duration(path: Path) -> float:
    """用 ffprobe 拿真实时长"""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception:
        pass
    return 0.0


def translate_via_siliconflow(text: str, api_key: str) -> str:
    """调 Hunyuan-MT-7B 翻译"""
    import httpx

    payload = {
        "model": "tencent/Hunyuan-MT-7B",
        "messages": [
            {"role": "system", "content": "你是专业英中翻译。请将以下英文翻译为简体中文。直接输出译文。"},
            {"role": "user", "content": text},
        ],
        "temperature": 0.2,
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    try:
        with httpx.Client(timeout=60) as client:
            resp = client.post(
                "https://api.siliconflow.cn/v1/chat/completions",
                json=payload, headers=headers,
            )
        if resp.status_code == 200:
            return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"  [TRANSLATE FAIL] {e}")
    return ""


def make_srt(subtitles: list, out_path: Path):
    """写 SRT 文件"""
    lines = []
    for i, s in enumerate(subtitles, 1):
        lines.append(str(i))
        lines.append(f"{seconds_to_srt_time(s['start'])} --> {seconds_to_srt_time(s['end'])}")
        lines.append(s["en"])
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def write_material_manifest(material_dir: Path, meta: dict):
    """为单个素材写一个 manifest 条目（让前端 /api/materials 能发现）"""
    out_dir = material_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    # 写 meta.json
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )


def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    print(f"=== BBC Process @ {today} ===")

    candidates_file = DAILY_DIR / today / "candidates.json"
    if not candidates_file.exists():
        print(f"[SKIP] no candidates: {candidates_file}")
        return

    candidates = json.loads(candidates_file.read_text(encoding="utf-8")).get("candidates", [])
    if not candidates:
        print("[SKIP] empty candidates")
        return

    dashscope_key = os.getenv("DASHSCOPE_API_KEY", "")
    siliconflow_key = os.getenv("SILICONFLOW_API_KEY", "")

    if not dashscope_key or not siliconflow_key:
        print("[ERROR] 需要 DASHSCOPE_API_KEY 和 SILICONFLOW_API_KEY 环境变量")
        sys.exit(1)

    daily_out = DAILY_DIR / today
    daily_out.mkdir(parents=True, exist_ok=True)

    processed = []

    for idx, cand in enumerate(candidates):
        print(f"\n--- 处理 {idx + 1}/{len(candidates)}: {cand['title'][:50]}")

        mat_id = f"bbc-{today}-{idx:02d}"
        work_dir = STATIC_DIR / mat_id
        work_dir.mkdir(parents=True, exist_ok=True)

        # 1. 下载或抽音
        audio_path = work_dir / "audio.mp3"
        video_local = daily_out / f"{mat_id}_video.mp4"

        got_audio = False
        if cand.get("audio_urls"):
            for url in cand["audio_urls"]:
                print(f"  [DL] {url}")
                if http_download(url, audio_path):
                    got_audio = True
                    break
        if not got_audio and cand.get("video_urls"):
            for url in cand["video_urls"]:
                if http_download(url, video_local):
                    if extract_audio(video_local, audio_path):
                        got_audio = True
                        break

        if not got_audio or not audio_path.exists() or audio_path.stat().st_size < 1000:
            print(f"  [SKIP] no audio downloaded")
            continue

        # 2. 拿真实时长
        duration_sec = get_audio_duration(audio_path)
        print(f"  [DUR] {duration_sec:.1f}s")

        # 3. ASR 转写
        print(f"  [ASR] calling DashScope...")
        asr = transcribe_via_dashscope(audio_path, dashscope_key)
        text = asr.get("text", "").strip()
        if not text:
            print(f"  [SKIP] ASR returned empty: {asr.get('error', '')}")
            continue

        # 4. 切句（按比例）
        subtitles = proportional_fallback(text, duration_sec)
        if not subtitles:
            continue

        # 5. 翻译（整段一次，省 API）
        print(f"  [TR] 翻译 {len(text)} chars...")
        zh = translate_via_siliconflow(text, siliconflow_key)

        # 简单按句子切分译文
        if zh:
            zh_parts = re.split(r"(?<=[。！？.!?])\s*", zh)
            zh_parts = [p.strip() for p in zh_parts if p.strip()]
            for i, s in enumerate(subtitles):
                s["zh"] = zh_parts[i] if i < len(zh_parts) else ""
        else:
            for s in subtitles:
                s["zh"] = ""

        # 6. 写 SRT
        make_srt(subtitles, work_dir / "subtitles.srt")

        # 7. 写素材元信息
        meta = {
            "id": mat_id,
            "title": cand["title"],
            "description": cand.get("description", ""),
            "category": "BBC News",
            "difficulty": "intermediate",
            "speed": 1.0,
            "icon": "BBC",
            "color": "#bb1919",
            "duration": duration_sec,
            "date": today,
            "source": "BBC Learning English",
            "source_url": cand["url"],
            "audio_url": f"/api/materials/{mat_id}/audio",
            "srt_url": f"/api/materials/{mat_id}/srt",
            "is_placeholder": False,
        }
        write_material_manifest(work_dir, meta)
        processed.append(meta)
        print(f"  [OK] {mat_id}")

    # 8. 更新 static/manifest.json（合并）
    manifest_file = STATIC_DIR / "manifest.json"
    existing = {"materials": []}
    if manifest_file.exists():
        try:
            existing = json.loads(manifest_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    # 替换或新增本次生成的素材
    new_ids = {m["id"] for m in processed}
    existing["materials"] = [
        m for m in existing.get("materials", [])
        if m.get("id") not in new_ids
    ] + processed
    existing["updated"] = today
    existing["note"] = "含 BBC 每日抓取 + 内置占位素材"

    manifest_file.write_text(
        json.dumps(existing, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n[MANIFEST] updated: {len(processed)} new, total {len(existing['materials'])}")

    # 退出码逻辑：candidates > 0 但成功数为 0 → 失败（用于触发邮件通知）
    if len(candidates) > 0 and len(processed) == 0:
        print(f"\n[ALERT] 抓取到 {len(candidates)} 个候选素材，但全部入库失败！", file=sys.stderr)
        sys.exit(2)
    elif len(candidates) > len(processed):
        failed = len(candidates) - len(processed)
        print(f"\n[WARN] {failed}/{len(candidates)} 个候选素材入库失败（部分成功）", file=sys.stderr)
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    main()
