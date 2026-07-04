"""YouTube subtitle fetching service with fallback paths.

Path order (best effort):
  1) yt-dlp json3 subtitles (primary, uses multiple player clients + PO Token provider)
  2) youtube-transcript-api (legacy fallback when yt-dlp fails)

Returns a unified dict:
    {
        "subtitles": [{"start": 0.0, "end": 2.5, "en": "text", "zh": ""}, ...],
        "language": "en",
        "is_auto_generated": bool,
        "raw_text": "full text",
        "source": "ytdlp_official" | "ytdlp_automatic" | "youtube_official" | "youtube_automatic",
    }

On failure a ``YouTubeSubtitleError`` is raised. It carries a structured
``error_code`` (no_subtitles, ip_blocked, po_token_required, network_error,
invalid_url, unknown) so the caller can show targeted guidance.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


# ============== 结构化异常 ==============

class YouTubeSubtitleError(Exception):
    """Raised when YouTube subtitle fetching fails.

    Attributes:
        error_code: One of no_subtitles, ip_blocked, po_token_required,
                    network_error, invalid_url, unknown.
        user_message: Human-readable suggestion text.
    """

    def __init__(self, message: str, error_code: str = "unknown", user_message: str = ""):
        super().__init__(message)
        self.error_code = error_code
        self.user_message = user_message or message


# ============== 公共：URL -> video_id ==============

_VIDEO_ID_PATTERNS = [
    r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/shorts/)([\w-]+)',
    r'youtube\.com/watch\?.*v=([\w-]+)',
]


def extract_video_id(url: str) -> Optional[str]:
    for pat in _VIDEO_ID_PATTERNS:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return None


# ============== 公共：短句合并 ==============

def _merge_short_subtitles(subtitles: list, min_duration: float = 3.0) -> list:
    """Merge short subtitle fragments into full sentences."""
    if not subtitles:
        return []

    merged = []
    current = None

    for sub in subtitles:
        text = (sub.get("en") or "").strip()
        if not text:
            continue

        if current and (text[0].isupper() or text.startswith(('"', "'"))) and current["en"]:
            duration = current["end"] - current["start"]
            if duration >= min_duration or text.endswith(('.', '!', '?')):
                merged.append(current)
                current = None

        if current is None:
            current = {
                "start": sub["start"],
                "end": sub["end"],
                "en": text,
                "zh": "",
            }
        else:
            current["end"] = sub["end"]
            if current["en"] and not current["en"].endswith(' ') and not text.startswith(' '):
                current["en"] += " "
            current["en"] += text

    if current and current["en"]:
        merged.append(current)

    return merged


def _clean_text(text: str) -> str:
    text = text.replace('♪', '').replace('♫', '')
    text = re.sub(r'\[.*?\]', '', text)
    text = re.sub(r'\(.*?\)', '', text)
    text = ' '.join(text.split())
    return text.strip()


# ============== 字幕格式转换 ==============

def _parse_json3_subtitles(json3_path: Path) -> list:
    """Parse yt-dlp json3 subtitle file into the unified structure.

    json3 格式示例:
    {
      "events": [
        {"tStartMs": 0, "dDurationMs": 2400,
         "segs": [{"utf8": "Hello there"}, {"utf8": ", world"}]},
        ...
      ]
    }
    """
    try:
        data = json.loads(json3_path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("Failed to parse json3 %s: %s", json3_path, e)
        return []

    out = []
    for ev in data.get("events", []):
        segs = ev.get("segs") or []
        if not segs:
            continue
        text = "".join((s.get("utf8") or "") for s in segs).strip()
        text = _clean_text(text)
        if not text:
            continue
        start = float(ev.get("tStartMs", 0)) / 1000.0
        duration = float(ev.get("dDurationMs", 0)) / 1000.0
        out.append({
            "start": round(start, 3),
            "end": round(start + duration, 3),
            "en": text,
            "zh": "",
        })
    return out


def _parse_srt_subtitles(srt_path: Path) -> list:
    """Fallback parser for srt/vtt files produced by yt-dlp."""
    try:
        content = srt_path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = srt_path.read_text(encoding="utf-8-sig", errors="ignore")

    out = []
    blocks = re.split(r"\n\s*\n", content.strip())
    for block in blocks:
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if len(lines) < 2:
            continue
        # 找到时间轴行
        time_line = next((ln for ln in lines if "-->" in ln), None)
        if not time_line:
            continue
        m = re.match(
            r"(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[.,](\d{1,3})",
            time_line,
        )
        if not m:
            continue
        h1, m1, s1, ms1, h2, m2, s2, ms2 = m.groups()
        start = int(h1) * 3600 + int(m1) * 60 + int(s1) + int(ms1.ljust(3, "0")) / 1000.0
        end = int(h2) * 3600 + int(m2) * 60 + int(s2) + int(ms2.ljust(3, "0")) / 1000.0
        text = " ".join(ln for ln in lines if ln != time_line and not ln.isdigit())
        text = _clean_text(text)
        if text:
            out.append({
                "start": round(start, 3),
                "end": round(end, 3),
                "en": text,
                "zh": "",
            })
    return out


def _parse_subtitle_file(path: Path) -> list:
    """根据扩展名选择解析器。"""
    ext = path.suffix.lower()
    if ext == ".json3":
        return _parse_json3_subtitles(path)
    if ext in (".srt", ".vtt"):
        return _parse_srt_subtitles(path)
    return []


# ============== 错误分类 ==============

_ERROR_PATTERNS = {
    "no_subtitles": [
        "no subtitles",
        "no automatic captions",
        "transcriptsdisabled",
        "transcript(s) not available",
        "this video does not have",
        "this video has no",
        "subtitles are not available",
    ],
    "ip_blocked": [
        "ip blocked",
        "request blocked",
        "blocked this ip",
        "429",
        "too many requests",
    ],
    "po_token_required": [
        "po token",
        "potoken",
        "botguard",
        "visitor data",
        "needs browser verification",
        "sign in to confirm",
    ],
    "network_error": [
        "connection",
        "timeout",
        "temporary failure",
        "name resolution",
        "unable to download",
        "network",
    ],
    "invalid_url": [
        "invalid youtube url",
        "unable to extract uploader id",
        "video unavailable",
        "private video",
        "this video is not available",
    ],
}


def _classify_error(exc: Exception) -> str:
    """根据异常消息返回结构化错误码。"""
    msg = str(exc).lower()
    for code, patterns in _ERROR_PATTERNS.items():
        for pat in patterns:
            if pat in msg:
                return code
    return "unknown"


def _user_message_for_error(code: str, original: str) -> str:
    """返回给终端用户的建议文本。"""
    if code == "no_subtitles":
        return (
            "This video has no available subtitles or auto-captions.\n"
            "Suggestions:\n"
            "  1. Try a different YouTube video\n"
            "  2. Upload an SRT/VTT subtitle file manually"
        )
    if code == "ip_blocked":
        return (
            "YouTube temporarily blocked this request (IP/rate limit).\n"
            "Suggestions:\n"
            "  1. Try again in a few minutes\n"
            "  2. Use a different network or proxy (set HTTP_PROXY/HTTPS_PROXY)\n"
            "  3. Set YT_COOKIES in backend/.env with your YouTube cookies\n"
            "  4. Upload an SRT/VTT subtitle file manually"
        )
    if code == "po_token_required":
        return (
            "YouTube requires additional verification (PO Token / BotGuard).\n"
            "Suggestions:\n"
            "  1. Install Node.js and run: pip install bgutil-ytdlp-pot-provider\n"
            "  2. Set YT_COOKIES in backend/.env with your logged-in YouTube cookies\n"
            "  3. Upload an SRT/VTT subtitle file manually"
        )
    if code == "network_error":
        return (
            "Network error while contacting YouTube.\n"
            "Suggestions:\n"
            "  1. Check your internet connection\n"
            "  2. If using a proxy, set HTTP_PROXY/HTTPS_PROXY\n"
            "  3. Try again later"
        )
    if code == "invalid_url":
        return (
            "This YouTube video is unavailable, private, or the URL is invalid.\n"
            "Suggestions:\n"
            "  1. Check the URL\n"
            "  2. Try a different video"
        )
    return original


# ============== 主路径 1: yt-dlp ==============

_YT_DLP_OPTS_BASE = {
    "skip_download": True,
    "writesubtitles": True,
    "writeautomaticsub": True,
    "subtitlesformat": "json3/srt/best",
    "subtitleslangs": ["en", "en-US", "en-GB", "zh-Hans", "zh-Hant", "zh"],
    "quiet": True,
    "no_warnings": True,
    "no_color": True,
    "noprogress": True,
    "socket_timeout": 30,
    "retries": 2,
    "ignoreerrors": False,
}


def _build_ydl(tmp_dir: Path, prefer_official: bool) -> dict:
    """根据偏好构造 YoutubeDL 选项。

    客户端顺序（按"PO Token 友好度"倒序）：
      1) web_embedded / tv_simply / android_vr -- 不需要 PO Token
      2) mweb / web / android / ios -- 需要 PO Token 时由插件注入
    """
    opts = dict(_YT_DLP_OPTS_BASE)
    opts["paths"] = {"home": str(tmp_dir)}
    opts["outtmpl"] = "%(id)s.%(ext)s"

    extractor_youtube = {
        # 多端兜底：先试不需要 PO Token 的客户端，再试 web/android/ios
        "player_client": [
            "web_embedded",
            "tv_simply",
            "android_vr",
            "mweb",
            "web",
            "android",
            "ios",
        ],
        # 显式请求 player JS，帮助某些客户端解析
        "player_skip": [],
        "skip": ["translated_subs", "hls"],
    }

    # ============== PO Token 自动提供者（bgutil-ytdlp-pot-provider）=============
    # 若安装了该插件，yt-dlp 会通过它自动获取 PO Token，无需手动设置环境变量。
    try:
        import bgutil_ytdlp_pot_provider  # noqa: F401
        extractor_youtube["getpot_bgutil"] = ["default"]
        logger.info("bgutil-ytdlp-pot-provider detected; automatic PO Token enabled")
    except Exception:
        logger.debug("bgutil-ytdlp-pot-provider not available; relying on manual tokens")

    # ============== 代理支持 ==============
    proxy = (
        os.getenv("YT_PROXY") or os.getenv("HTTPS_PROXY") or os.getenv("HTTP_PROXY") or os.getenv("ALL_PROXY")
    )
    if proxy:
        opts["proxy"] = proxy
        logger.info("yt-dlp using proxy: %s", proxy)

    # ============== visitor_data / data_sync_id ==============
    visitor_data = os.getenv("YT_VISITOR_DATA", "").strip()
    data_sync_id = os.getenv("YT_DATA_SYNC_ID", "").strip()
    if visitor_data:
        extractor_youtube["visitor_data"] = [visitor_data]
    if data_sync_id:
        extractor_youtube["data_sync_id"] = [data_sync_id]

    opts["extractor_args"] = {"youtube": extractor_youtube}

    # 启用 Node.js 等 JS 运行时（yt-dlp 推荐，处理 BotGuard 挑战）
    opts["js_runtimes"] = {"node": {}}

    # 优先官方 vs 优先自动
    if prefer_official:
        opts["writesubtitles"] = True
        opts["writeautomaticsub"] = True

    # ============== cookies 支持 ==============
    cookies_path = os.getenv("YT_COOKIES", "").strip()
    if cookies_path:
        cookies_file = Path(cookies_path)
        if cookies_file.is_file():
            opts["cookiefile"] = str(cookies_file)
            logger.info("yt-dlp using cookies file: %s", cookies_file)
        else:
            logger.warning("YT_COOKIES file not found: %s", cookies_file)

    # ============== 手动 PO Token 注入（覆盖/补充插件）=============
    gvs_pot = os.getenv("YT_GVS_PO_TOKEN", "").strip()
    player_pot = os.getenv("YT_PLAYER_PO_TOKEN", "").strip()
    if gvs_pot or player_pot:
        extractor_args = opts.setdefault("extractor_args", {}).setdefault("youtube", {})
        pot_list = []
        if gvs_pot:
            pot_list.append(f"gvs+{gvs_pot}")
        if player_pot:
            pot_list.append(f"player+{player_pot}")
        if pot_list:
            extractor_args["po_token"] = pot_list
            logger.info("yt-dlp injected manual PO Token")

    return opts


def _find_subtitle_files(tmp_dir: Path, video_id: str) -> list:
    """在临时目录中查找 yt-dlp 产出的字幕文件。"""
    candidates = []
    for ext in (".json3", ".srt", ".vtt"):
        candidates.extend(tmp_dir.glob(f"{video_id}*{ext}"))
    return candidates


def _detect_official_or_auto(path: Path, video_id: str) -> str:
    """yt-dlp 的字幕命名形如 <video_id>.<lang>.json3 或 .<lang>.live_chat.json3 等。
    自动字幕会带 .live_chat 之外，没有专门的 auto 标志，只能用路径 + 内容启发式判断。
    这里采用保守策略：若路径中包含官方语言标签（en, en-US, en-GB）则视为官方。
    """
    name = path.stem.lower()
    # 去掉视频 id 前缀
    if name.startswith(video_id.lower()):
        name = name[len(video_id):].lstrip(".")
    # 自动字幕 yt-dlp 默认命名: <id>.<lang>.json3 (人工/自动同前缀)
    # 实际上 yt-dlp 不会明确区分文件；is_generated 在 extract_info 阶段可读
    return name  # 留给调用方结合 _is_automatic_in_info 判断


def _run_ytdlp(video_url: str, tmp_dir: Path) -> dict:
    """调用 yt-dlp 抓取字幕 + 视频元信息。

    writesubtitles=True + skip_download=True 时，yt-dlp 仍会下载字幕文件
    （只是不下视频/音频流）。所以一次 extract_info + download 即可。
    """
    try:
        from yt_dlp import YoutubeDL
    except ImportError:
        raise RuntimeError("yt-dlp is not installed. Run: pip install yt-dlp")

    opts = _build_ydl(tmp_dir, prefer_official=True)
    opts["noprogress"] = True

    info = None
    with YoutubeDL(opts) as ydl:
        # download=True 时会保存字幕到 outtmpl；info 也会从 result 拿到
        result = ydl.extract_info(video_url, download=True)
        if isinstance(result, dict):
            info = result
        else:
            # 多视频场景会返回 playlist；单视频仍是 dict
            info = None

    return {
        "info": info or {},
        "tmp_dir": tmp_dir,
    }


def fetch_via_ytdlp(video_url: str) -> dict:
    """主路径：用 yt-dlp 抓 YouTube 字幕。

    返回统一结构。失败抛 YouTubeSubtitleError。
    """
    video_id = extract_video_id(video_url)
    if not video_id:
        raise YouTubeSubtitleError(
            "Invalid YouTube URL",
            error_code="invalid_url",
            user_message=_user_message_for_error("invalid_url", "Invalid YouTube URL"),
        )

    tmp_dir = Path(tempfile.mkdtemp(prefix="shadow_yt_"))
    try:
        try:
            result = _run_ytdlp(video_url, tmp_dir)
        except Exception as e:
            code = _classify_error(e)
            raise YouTubeSubtitleError(
                f"yt-dlp failed: {e}",
                error_code=code,
                user_message=_user_message_for_error(code, f"yt-dlp failed: {e}"),
            ) from e

        info = result["info"] or {}

        # 1) 找字幕文件
        sub_files = _find_subtitle_files(tmp_dir, video_id)
        subtitles: list = []
        used_path: Optional[Path] = None
        for p in sub_files:
            parsed = _parse_subtitle_file(p)
            if parsed:
                subtitles = parsed
                used_path = p
                break

        if not subtitles:
            msg = f"yt-dlp produced no usable subtitle files ({len(sub_files)} candidate(s) found but parsing empty)"
            raise YouTubeSubtitleError(
                msg,
                error_code="no_subtitles",
                user_message=_user_message_for_error("no_subtitles", msg),
            )

        # 2) 判断官方 vs 自动：优先从 info.subtitles / info.automatic_captions 反查
        is_auto = False
        official_langs = set()
        auto_langs = set()
        for lang, tracks in (info.get("subtitles") or {}).items():
            if tracks:
                official_langs.add(lang)
        for lang, tracks in (info.get("automatic_captions") or {}).items():
            if tracks:
                auto_langs.add(lang)

        if used_path is not None:
            stem = used_path.stem
            # 形如 "<id>.<lang>.json3" 或 "<id>-<lang>.json3"
            parts = re.split(r"[.\-]", stem)
            lang_in_name = parts[-1] if len(parts) >= 2 else ""
            if lang_in_name in official_langs:
                is_auto = False
            elif lang_in_name in auto_langs:
                is_auto = True
            else:
                # 默认视作自动字幕（最常见情况）
                is_auto = True

        merged = _merge_short_subtitles(subtitles)
        if not merged:
            msg = "Subtitle merging produced no sentences"
            raise YouTubeSubtitleError(
                msg,
                error_code="no_subtitles",
                user_message=_user_message_for_error("no_subtitles", msg),
            )

        full_text = " ".join(s["en"] for s in merged)

        source = "ytdlp_automatic" if is_auto else "ytdlp_official"
        logger.info(
            "yt-dlp subtitles fetched: %s, %d sentences, official=%s, lang=%s",
            video_id, len(merged), not is_auto, used_path.suffix if used_path else '?'
        )

        return {
            "subtitles": merged,
            "language": _guess_lang_from_filename(used_path) if used_path else "en",
            "is_auto_generated": is_auto,
            "raw_text": full_text,
            "source": source,
            "duration": float(info.get("duration") or 0) or None,
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def _guess_lang_from_filename(path: Optional[Path]) -> str:
    if not path:
        return "en"
    stem = path.stem
    parts = re.split(r"[.\-]", stem)
    if len(parts) >= 2:
        return parts[-1]
    return "en"


# ============== 主路径 2: youtube-transcript-api（旧） ==============

def fetch_via_ytt_api(video_url: str, languages: Optional[list] = None) -> dict:
    """降级路径：仍走旧的 youtube-transcript-api 库。

    在网络好、IP 不被封的情况下仍可用，作为 yt-dlp 的回退。
    """
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import (
        TranscriptsDisabled,
        NoTranscriptFound,
        IpBlocked,
        RequestBlocked,
    )

    video_id = extract_video_id(video_url)
    if not video_id:
        raise YouTubeSubtitleError(
            "Invalid YouTube URL",
            error_code="invalid_url",
            user_message=_user_message_for_error("invalid_url", "Invalid YouTube URL"),
        )

    if languages is None:
        languages = ['en', 'en-US', 'en-GB']

    ytt = YouTubeTranscriptApi()

    # 先列出可用字幕，优先匹配请求语言；无匹配时取任意可用语言。
    available_transcripts = []
    try:
        available_transcripts = list(ytt.list(video_id))
    except (IpBlocked, RequestBlocked) as e:
        raise YouTubeSubtitleError(
            f"YouTube blocked this IP: {e}",
            error_code="ip_blocked",
            user_message=_user_message_for_error("ip_blocked", f"YouTube blocked this IP: {e}"),
        ) from e
    except Exception:
        available_transcripts = []

    ordered_languages = list(languages)
    for t in available_transcripts:
        if t.language_code not in ordered_languages:
            ordered_languages.append(t.language_code)

    last_err = None
    for lang in ordered_languages:
        try:
            transcript = ytt.fetch(video_id, languages=[lang])
            raw = transcript.to_raw_data()
            # 判断是否为自动生成：从可用列表中查找
            is_auto = any(t.language_code == lang and t.is_generated for t in available_transcripts)
            source = "youtube_automatic" if is_auto else "youtube_official"
            return _build_from_raw(raw, is_auto=is_auto, source=source, language=lang)
        except (NoTranscriptFound, TranscriptsDisabled) as e:
            last_err = e
            continue
        except (IpBlocked, RequestBlocked) as e:
            raise YouTubeSubtitleError(
                f"YouTube blocked this IP: {e}",
                error_code="ip_blocked",
                user_message=_user_message_for_error("ip_blocked", f"YouTube blocked this IP: {e}"),
            ) from e
        except Exception as e:
            code = _classify_error(e)
            raise YouTubeSubtitleError(
                f"youtube-transcript-api failed: {e}",
                error_code=code,
                user_message=_user_message_for_error(code, f"youtube-transcript-api failed: {e}"),
            ) from e

    # 再尝试不指定语言（自动选择任意可用字幕）
    try:
        transcript = ytt.fetch(video_id)
        raw = transcript.to_raw_data()
        return _build_from_raw(raw, is_auto=True, source="youtube_automatic", language="auto")
    except (NoTranscriptFound, TranscriptsDisabled) as e:
        last_err = e
    except (IpBlocked, RequestBlocked) as e:
        raise YouTubeSubtitleError(
            f"YouTube blocked this IP: {e}",
            error_code="ip_blocked",
            user_message=_user_message_for_error("ip_blocked", f"YouTube blocked this IP: {e}"),
        ) from e
    except Exception as e:
        code = _classify_error(e)
        raise YouTubeSubtitleError(
            f"youtube-transcript-api failed: {e}",
            error_code=code,
            user_message=_user_message_for_error(code, f"youtube-transcript-api failed: {e}"),
        ) from e

    msg = "This video has no available subtitles"
    raise YouTubeSubtitleError(
        msg,
        error_code="no_subtitles",
        user_message=_user_message_for_error("no_subtitles", msg),
    ) from last_err


def _build_from_raw(raw: list, is_auto: bool, source: str, language: str) -> dict:
    subtitles = []
    for item in raw:
        start = item.get('start', 0)
        duration = item.get('duration', 0)
        text = _clean_text((item.get('text') or '').strip())
        if not text:
            continue
        subtitles.append({
            "start": round(start, 3),
            "end": round(start + duration, 3),
            "en": text,
            "zh": "",
        })
    if not subtitles:
        msg = "Subtitle content is empty"
        raise YouTubeSubtitleError(
            msg,
            error_code="no_subtitles",
            user_message=_user_message_for_error("no_subtitles", msg),
        )
    merged = _merge_short_subtitles(subtitles)
    full_text = " ".join(s["en"] for s in merged)
    return {
        "subtitles": merged,
        "language": language,
        "is_auto_generated": is_auto,
        "raw_text": full_text,
        "source": source,
        "duration": None,
    }


# ============== 统一入口 ==============

async def get_youtube_subtitles(video_url: str, languages: Optional[list] = None) -> dict:
    """统一入口：先 yt-dlp，失败再 youtube-transcript-api。

    失败抛 YouTubeSubtitleError，携带 error_code 和 user_message。
    """
    errors: list[tuple[str, str]] = []

    # 1) yt-dlp
    try:
        logger.info("[yt-dlp] Trying YouTube subtitles: %s", video_url)
        return fetch_via_ytdlp(video_url)
    except YouTubeSubtitleError:
        raise
    except Exception as e:
        msg = f"yt-dlp failed: {e}"
        logger.warning(msg)
        errors.append(("yt-dlp", msg))

    # 2) youtube-transcript-api
    try:
        logger.info("[ytt-api] Falling back to youtube-transcript-api: %s", video_url)
        return fetch_via_ytt_api(video_url, languages=languages)
    except YouTubeSubtitleError:
        raise
    except Exception as e:
        msg = f"youtube-transcript-api failed: {e}"
        logger.warning(msg)
        errors.append(("youtube-transcript-api", msg))

    # 两条路都挂了
    detail = " | ".join(f"{src}: {err}" for src, err in errors)
    raise YouTubeSubtitleError(
        f"Failed to fetch YouTube subtitles. {detail}",
        error_code="unknown",
        user_message=(
            "Failed to fetch YouTube subtitles (tried yt-dlp and youtube-transcript-api).\n"
            "Possible reasons: no subtitles / network restriction / IP blocked.\n"
            "Suggestions:\n"
            "  1. Try another YouTube video\n"
            "  2. Switch network environment or set a proxy\n"
            "  3. Upload a subtitle file (SRT) manually\n"
            "  4. Use a direct video link and generate AI subtitles\n\n"
            f"Details: {detail}"
        ),
    )


# ============== 旧 API 兼容（main.py 中 _merge_short_subtitles 已迁出） ==============

async def get_youtube_info(video_url: str) -> dict:
    """获取 YouTube 视频基本信息（语言列表等），优先 yt-dlp。"""
    video_id = extract_video_id(video_url)
    if not video_id:
        raise ValueError("Invalid YouTube URL")

    # 1) yt-dlp 优先
    try:
        from yt_dlp import YoutubeDL
        opts = {
            "skip_download": True,
            "listsubtitles": True,
            "quiet": True,
            "no_warnings": True,
            "socket_timeout": 20,
            "extractor_args": {"youtube": {"player_client": ["web_embedded", "tv_simply", "android_vr", "web", "android", "ios"]}},
        }
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(video_url, download=False)

        subs = info.get("subtitles") or {}
        autos = info.get("automatic_captions") or {}
        available = []
        for lang, tracks in subs.items():
            if tracks:
                available.append({"code": lang, "name": lang, "is_generated": False})
        for lang, tracks in autos.items():
            if tracks and not any(a["code"] == lang for a in available):
                available.append({"code": lang, "name": lang, "is_generated": True})

        return {
            "video_id": video_id,
            "has_subtitles": len(available) > 0,
            "languages": available,
            "is_translatable": bool(autos),
        }
    except Exception as e:
        logger.warning("yt-dlp info fetch failed, falling back to youtube-transcript-api: %s", e)

    # 2) fallback
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        transcript_list = YouTubeTranscriptApi().list(video_id)
        available = []
        for transcript in transcript_list:
            available.append({
                "code": transcript.language_code,
                "name": str(transcript.language),
                "is_generated": transcript.is_generated,
            })
        is_translatable = False
        try:
            transcript_list.find_transcript(['zh', 'zh-CN'])
            is_translatable = True
        except Exception:
            pass
        return {
            "video_id": video_id,
            "has_subtitles": len(available) > 0,
            "languages": available,
            "is_translatable": is_translatable,
        }
    except Exception as e:
        logger.warning("Failed to fetch YouTube info: %s", e)
        return {
            "video_id": video_id,
            "has_subtitles": False,
            "languages": [],
            "is_translatable": False,
            "error": "ip_blocked" if "IpBlocked" in type(e).__name__ else "unknown",
        }
