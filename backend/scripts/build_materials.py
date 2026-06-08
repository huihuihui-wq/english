"""Generate placeholder materials (no espeak needed)"""
import json
import wave
import struct
import math
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "data" / "materials" / "static"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MATERIALS = [
    {
        "id": "daily-greetings",
        "title": "Daily Greetings - Daily English",
        "description": "10 common greetings, slow 0.8x, beginner level",
        "category": "Daily",
        "difficulty": "beginner",
        "speed": 0.8,
        "icon": "WS",
        "color": "#4ade80",
        "sentences": [
            (0.0, 2.5, "Hello, how are you today?"),
            (2.5, 5.0, "I am doing well, thank you for asking."),
            (5.0, 7.5, "What is your name, if I may ask?"),
            (7.5, 10.0, "My name is John. Nice to meet you."),
            (10.0, 12.5, "Where are you from originally?"),
            (12.5, 15.0, "I am from New York, but I live in London now."),
            (15.0, 17.5, "That sounds exciting. Do you like it there?"),
            (17.5, 20.0, "Yes, I love the culture and the people."),
            (20.0, 22.5, "Have a great day ahead of you."),
            (22.5, 25.0, "Thank you, you too. See you next time."),
        ],
    },
    {
        "id": "news-headlines",
        "title": "News Headlines - News English",
        "description": "News broadcast style, normal speed, intermediate level",
        "category": "News",
        "difficulty": "intermediate",
        "speed": 1.0,
        "icon": "NEWS",
        "color": "#4f8cff",
        "sentences": [
            (0.0, 3.0, "Breaking news from the capital this morning."),
            (3.0, 6.0, "The president addressed the nation last night."),
            (6.0, 9.0, "He spoke about the importance of unity."),
            (9.0, 12.5, "Meanwhile, markets opened higher across Asia."),
            (12.5, 16.0, "Economists predict steady growth for the quarter."),
            (16.0, 19.5, "In sports, the home team won the championship."),
            (19.5, 23.0, "Fans celebrated in the streets until midnight."),
        ],
    },
    {
        "id": "tech-talk",
        "title": "Tech Talk - Technology",
        "description": "AI/Tech topics, fast 1.2x, advanced level",
        "category": "Tech",
        "difficulty": "advanced",
        "speed": 1.2,
        "icon": "AI",
        "color": "#ffb84d",
        "sentences": [
            (0.0, 2.8, "Artificial intelligence is transforming every industry."),
            (2.8, 5.8, "Machine learning models now process millions of data points."),
            (5.8, 8.8, "Cloud computing has made powerful tools accessible to everyone."),
            (8.8, 11.8, "Startups are leveraging these technologies to disrupt markets."),
            (11.8, 14.8, "However, privacy and security remain critical concerns."),
            (14.8, 17.8, "Developers must balance innovation with ethical responsibility."),
        ],
    },
    {
        "id": "travel-phrases",
        "title": "Travel Phrases - Travel English",
        "description": "Airport / Hotel / Restaurant common sentences",
        "category": "Travel",
        "difficulty": "beginner",
        "speed": 0.9,
        "icon": "AIR",
        "color": "#a78bfa",
        "sentences": [
            (0.0, 2.5, "Where is the boarding gate for flight 202?"),
            (2.5, 5.5, "The gate is B12, on your left after security."),
            (5.5, 8.0, "I would like to check in, please. I have a reservation."),
            (8.0, 11.0, "Welcome. May I see your passport and credit card?"),
            (11.0, 14.0, "Could I have a room with a view of the ocean?"),
            (14.0, 17.0, "Sure, we have a lovely sea-view room available."),
            (17.0, 20.0, "What time does the restaurant close tonight?"),
            (20.0, 22.5, "The restaurant is open until eleven o'clock."),
        ],
    },
    {
        "id": "business-email",
        "title": "Business Email - Business English",
        "description": "Formal business English, email writing",
        "category": "Business",
        "difficulty": "intermediate",
        "speed": 1.0,
        "icon": "BIZ",
        "color": "#f472b6",
        "sentences": [
            (0.0, 3.0, "I am writing to follow up on our previous discussion."),
            (3.0, 6.0, "Thank you for your prompt response to my inquiry."),
            (6.0, 9.0, "I would appreciate it if you could provide more details."),
            (9.0, 12.0, "Please let me know if you have any questions or concerns."),
            (12.0, 15.0, "I look forward to hearing from you at your earliest convenience."),
            (15.0, 18.0, "Best regards, and thank you for your time and consideration."),
        ],
    },
]


def generate_placeholder_wav(duration: float, path: Path, base_freq: float = 220):
    """Generate placeholder audio with short beeps for shadowing practice."""
    sample_rate = 22050
    n_samples = int(sample_rate * duration)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        for i in range(n_samples):
            t = i / sample_rate
            mod = (t * 2) % 1
            if mod < 0.05:
                value = int(8000 * math.sin(2 * math.pi * 800 * t))
            else:
                value = int(80 * math.sin(2 * math.pi * base_freq * t))
            wf.writeframes(struct.pack("<h", max(-32767, min(32767, value))))


def make_srt(sentences, out_path: Path):
    def fmt(t):
        h = int(t // 3600)
        m = int((t % 3600) // 60)
        s = int(t % 60)
        ms = int((t - int(t)) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines = []
    for i, (start, end, text) in enumerate(sentences, 1):
        lines.append(str(i))
        lines.append(f"{fmt(start)} --> {fmt(end)}")
        lines.append(text)
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def main():
    print(f"Output: {OUT_DIR}")
    manifest = []

    for mat in MATERIALS:
        work_dir = OUT_DIR / mat["id"]
        work_dir.mkdir(parents=True, exist_ok=True)

        print(f"\n[GEN] {mat['title']} ({mat['id']})")

        duration = mat["sentences"][-1][1] + 0.5
        audio_path = work_dir / "audio.wav"
        generate_placeholder_wav(duration, audio_path, base_freq=440)
        print(f"  [OK] audio.wav ({audio_path.stat().st_size} bytes, {duration:.1f}s)")

        srt_path = work_dir / "subtitles.srt"
        make_srt(mat["sentences"], srt_path)
        print(f"  [OK] subtitles.srt ({srt_path.stat().st_size} bytes)")

        manifest.append({
            "id": mat["id"],
            "title": mat["title"],
            "description": mat["description"],
            "category": mat["category"],
            "difficulty": mat["difficulty"],
            "speed": mat["speed"],
            "icon": mat["icon"],
            "color": mat["color"],
            "duration": duration,
            "audio_url": f"/api/materials/{mat['id']}/audio",
            "srt_url": f"/api/materials/{mat['id']}/srt",
            "is_placeholder": True,
        })
        print(f"  [DONE] {mat['title']}")

    manifest_path = OUT_DIR / "manifest.json"
    manifest_path.write_text(
        json.dumps({
            "materials": manifest,
            "updated": "2026-06-08",
            "note": "Placeholder materials. Replace via scripts/build_materials.py with real audio.",
        }, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n[MANIFEST] {manifest_path}")
    print(f"Total: {len(manifest)} materials")


if __name__ == "__main__":
    main()
