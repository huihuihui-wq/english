"""YouTube 字幕获取服务 - 直接解析 YouTube 官方字幕"""
import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)


def extract_video_id(url: str) -> Optional[str]:
    """从 YouTube URL 提取视频 ID"""
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([\w-]+)',
        r'youtube\.com/watch\?.*v=([\w-]+)',
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


async def get_youtube_subtitles(video_url: str, languages: list = None) -> dict:
    """
    获取 YouTube 视频字幕。
    
    返回:
        {
            "subtitles": [{"start": 0.0, "end": 2.5, "en": "text", "zh": ""}, ...],
            "language": "en",
            "is_auto_generated": False,
            "raw_text": "完整文本"
        }
    """
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import TranscriptsDisabled, NoTranscriptFound, IpBlocked

    video_id = extract_video_id(video_url)
    if not video_id:
        raise ValueError("无效的 YouTube 链接")

    if languages is None:
        languages = ['en', 'en-US', 'en-GB']

    try:
        # 尝试获取指定语言的字幕
        transcript = YouTubeTranscriptApi().fetch(video_id, languages=languages)
        transcript_list = transcript.to_raw_data()
        language = languages[0] if languages else "en"
        is_auto = False
    except NoTranscriptFound:
        # 如果没有找到指定语言，尝试获取自动生成的字幕
        logger.info(f"未找到官方字幕，尝试自动生成的字幕: {video_id}")
        try:
            transcript = YouTubeTranscriptApi().fetch(video_id)
            transcript_list = transcript.to_raw_data()
            language = "auto"
            is_auto = True
        except Exception:
            raise ValueError("该视频没有可用的字幕。请尝试其他视频或手动上传字幕文件。")
    except TranscriptsDisabled:
        raise ValueError("该视频已禁用字幕。请尝试其他视频或手动上传字幕文件。")
    except IpBlocked:
        raise ValueError(
            "YouTube 暂时阻止了字幕获取（IP 限制）。\n"
            "建议：\n"
            "1. 尝试其他 YouTube 视频\n"
            "2. 切换到不同的网络环境\n"
            "3. 手动上传字幕文件（SRT 格式）\n"
            "4. 使用直接视频链接（非 YouTube）并生成 AI 字幕"
        )
    except Exception as e:
        logger.error(f"获取 YouTube 字幕失败: {e}")
        raise ValueError(f"获取字幕失败: {str(e)}")

    # 转换为统一格式
    subtitles = []
    full_text = ""

    for i, item in enumerate(transcript_list):
        start = item.get('start', 0)
        duration = item.get('duration', 0)
        end = start + duration
        text = item.get('text', '').strip()

        if not text:
            continue

        # 清理 YouTube 字幕格式
        text = _clean_youtube_text(text)

        subtitles.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "en": text,
            "zh": "",
        })

        if full_text:
            full_text += " "
        full_text += text

    if not subtitles:
        raise ValueError("字幕内容为空")

    logger.info(f"YouTube 字幕获取成功: {video_id}, {len(subtitles)} 条, 语言={language}")

    return {
        "subtitles": subtitles,
        "language": language,
        "is_auto_generated": is_auto,
        "raw_text": full_text,
    }


def _clean_youtube_text(text: str) -> str:
    """清理 YouTube 字幕文本"""
    # 移除音乐符号
    text = text.replace('♪', '').replace('♫', '')
    # 移除方括号内容（如 [Music], [Applause]）
    text = re.sub(r'\[.*?\]', '', text)
    # 移除圆括号内容
    text = re.sub(r'\(.*?\)', '', text)
    # 清理多余空格
    text = ' '.join(text.split())
    return text.strip()


async def get_youtube_info(video_url: str) -> dict:
    """获取 YouTube 视频基本信息"""
    from youtube_transcript_api import YouTubeTranscriptApi

    video_id = extract_video_id(video_url)
    if not video_id:
        raise ValueError("无效的 YouTube 链接")

    try:
        # 获取可用的字幕列表
        transcript_list = YouTubeTranscriptApi().list(video_id)

        available_languages = []
        is_translatable = False

        for transcript in transcript_list:
            lang_code = transcript.language_code
            lang_name = transcript.language
            is_generated = transcript.is_generated

            available_languages.append({
                "code": lang_code,
                "name": str(lang_name),
                "is_generated": is_generated,
            })

        # 检查是否可翻译
        try:
            transcript_list.find_transcript(['zh', 'zh-CN'])
            is_translatable = True
        except:
            pass

        return {
            "video_id": video_id,
            "has_subtitles": len(available_languages) > 0,
            "languages": available_languages,
            "is_translatable": is_translatable,
        }

    except Exception as e:
        logger.warning(f"获取 YouTube 信息失败: {e}")
        return {
            "video_id": video_id,
            "has_subtitles": False,
            "languages": [],
            "is_translatable": False,
            "error": "ip_blocked" if "IpBlocked" in type(e).__name__ else "unknown"
        }
