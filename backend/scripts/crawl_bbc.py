"""
BBC Learning English 爬虫
每天拉取 1-2 个最新节目标题与详情页 URL。

输出：backend/data/materials/daily/YYYY-MM-DD/candidates.json
下一步会由 process_bbc.py 调 ASR + 翻译 + 入库。
"""
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

# BBC Learning English 入口
BASE = "https://www.bbc.co.uk/learningenglish/english/features"
INDEX_PAGES = [
    f"{BASE}/news-review",       # 新闻点评
    f"{BASE}/english-in-a-minute",
    f"{BASE}/lingohack",
]

# 部分页面也可能作为入口
EXTRA_PAGES = [
    f"{BASE}/the-english-we-speak",
    f"{BASE}/6-minute-english",
    f"{BASE}/drama",
]


def http_get(url: str, timeout: int = 30) -> str:
    """简单 GET，伪装 UA"""
    req = Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) "
                      "Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-GB,en;q=0.9",
    })
    with urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="ignore")


def extract_episode_links(html: str) -> list:
    """从索引页提取单集链接"""
    # BBC 页面的 episode 链接特征 /english/features/<series>/<slug>
    pattern = re.compile(
        r'href="(https?://www\.bbc\.co\.uk/learningenglish/english/features/[^/"]+/[0-9a-z\-]+)"',
        re.IGNORECASE,
    )
    seen = set()
    out = []
    for m in pattern.finditer(html):
        url = m.group(1)
        if url in seen:
            continue
        seen.add(url)
        out.append(url)
    return out


def parse_episode_page(url: str) -> dict | None:
    """
    抓取单集详情页，提取：
    - title
    - mp3 音频 URL（BBC 通常有 .mp3 资源）
    - 视频 URL（如有）
    - 内嵌文本段落
    """
    try:
        html = http_get(url)
    except (URLError, HTTPError, TimeoutError) as e:
        print(f"  [SKIP] {url}: {e}")
        return None

    # 标题
    title_match = re.search(r'<meta[^>]+property="og:title"[^>]+content="([^"]+)"', html)
    if not title_match:
        title_match = re.search(r"<h1[^>]*>([^<]+)</h1>", html)
    title = title_match.group(1).strip() if title_match else "Untitled"

    # 描述
    desc_match = re.search(r'<meta[^>]+property="og:description"[^>]+content="([^"]+)"', html)
    description = desc_match.group(1).strip() if desc_match else ""

    # 音频/视频 URL
    audio_urls = list(set(re.findall(r'https?://[^"\'\s]+\.mp3', html)))
    video_urls = list(set(re.findall(
        r'https?://[^"\'\s]+\.(?:mp4|m3u8)', html, re.IGNORECASE
    )))

    # BBC 常用 audio 模式：/learningenglish/.../audio/<slug>.mp3
    if not audio_urls:
        slug_match = re.search(r'/features/[^/]+/([0-9a-z\-]+)', url)
        if slug_match:
            slug = slug_match.group(1)
            for ext in ("mp3",):
                candidate = f"https://downloads.bbc.co.uk/learningenglish/features/{slug}/{slug}.{ext}"
                audio_urls.append(candidate)

    return {
        "title": title,
        "description": description,
        "url": url,
        "audio_urls": audio_urls,
        "video_urls": video_urls,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_dir = Path(__file__).resolve().parent.parent / "data" / "materials" / "daily" / today
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"=== BBC Learning English Crawler @ {today} ===")

    candidates = []

    # 1. 抓所有索引页
    all_episode_urls = set()
    for page in INDEX_PAGES + EXTRA_PAGES:
        try:
            print(f"[IDX] {page}")
            html = http_get(page)
            links = extract_episode_links(html)
            print(f"  -> {len(links)} episodes")
            all_episode_urls.update(links)
        except (URLError, HTTPError, TimeoutError) as e:
            print(f"  [SKIP] {page}: {e}")
            continue
        time.sleep(0.5)

    print(f"\nTotal unique episodes: {len(all_episode_urls)}")

    # 2. 取最新 3 个 episode 抓详情（避免太多请求）
    latest = sorted(all_episode_urls, reverse=True)[:3]

    for ep_url in latest:
        print(f"\n[EP] {ep_url}")
        ep = parse_episode_page(ep_url)
        if ep:
            candidates.append(ep)
            print(f"  title: {ep['title']}")
            print(f"  audio: {len(ep['audio_urls'])} urls")
            print(f"  video: {len(ep['video_urls'])} urls")
        time.sleep(1)

    # 3. 写 candidates.json
    out_file = out_dir / "candidates.json"
    out_file.write_text(
        json.dumps({
            "date": today,
            "candidates": candidates,
            "total": len(candidates),
        }, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n[SAVED] {out_file} ({len(candidates)} candidates)")


if __name__ == "__main__":
    main()
