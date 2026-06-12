"""Audio content classifier for non-speech segments.

Distinguishes:
  - speech
  - music
  - applause
  - silence / background noise

Uses scipy/numpy for spectral/temporal features. No ML model to download.
"""
from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from typing import List, Optional

import numpy as np
from scipy.signal import stft

logger = logging.getLogger(__name__)

SAMPLE_RATE = 16000
WINDOW_SECONDS = 0.5
HOP_SECONDS = 0.25


def _decode_to_pcm(audio_bytes: bytes, source_ext: str = "mp3") -> np.ndarray:
    """Decode audio to mono 16 kHz float PCM [-1, 1]."""
    with tempfile.NamedTemporaryFile(suffix=f".{source_ext}", delete=False) as src:
        src.write(audio_bytes)
        src_path = src.name
    out_path = src_path.rsplit(".", 1)[0] + "_classify.wav"
    try:
        cmd = [
            "ffmpeg", "-y", "-i", src_path,
            "-vn", "-map", "0:a",
            "-acodec", "pcm_s16le",
            "-ac", "1", "-ar", str(SAMPLE_RATE),
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg decode failed: {result.stderr[:500]}")

        import wave
        with wave.open(out_path, "rb") as wf:
            nframes = wf.getnframes()
            pcm = np.frombuffer(wf.readframes(nframes), dtype=np.int16)
            return pcm.astype(np.float32) / 32768.0
    finally:
        for p in (src_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def _frame_features(y: np.ndarray, sr: int = SAMPLE_RATE):
    """Compute per-window features using scipy STFT."""
    window_samples = int(WINDOW_SECONDS * sr)
    hop_samples = int(HOP_SECONDS * sr)
    n_fft = max(window_samples, 2048)

    # Time-domain RMS (accurate)
    num_frames = 1 + (len(y) - window_samples) // hop_samples
    rms = np.array([
        np.sqrt(np.mean(y[i * hop_samples:i * hop_samples + window_samples] ** 2) + 1e-10)
        for i in range(num_frames)
    ])
    times = (np.arange(num_frames) * hop_samples + window_samples / 2) / sr

    # Use scipy STFT for spectral features
    f, _, Zxx = stft(
        y,
        fs=sr,
        nperseg=window_samples,
        noverlap=window_samples - hop_samples,
        nfft=n_fft,
        window="hann",
        boundary=None,
        padded=False,
    )
    spec = np.abs(Zxx)
    power = spec ** 2

    flatness = np.zeros(num_frames)
    centroid = np.zeros(num_frames)
    rolloff = np.zeros(num_frames)

    for i in range(num_frames):
        p = power[:, i]
        total_p = np.sum(p) + 1e-10
        log_p = np.log(p + 1e-10)
        geometric = np.exp(np.mean(log_p))
        flatness[i] = geometric / (np.mean(p) + 1e-10)
        centroid[i] = np.sum(f * p) / total_p
        cumsum = np.cumsum(p)
        rolloff_idx = np.argmax(cumsum >= 0.85 * total_p)
        rolloff[i] = f[rolloff_idx]

    zcr = np.array([
        np.mean(np.abs(np.diff(np.sign(
            y[i * hop_samples:i * hop_samples + window_samples]
        )))) / 2.0
        for i in range(num_frames)
    ])

    # Onset strength: frame-to-frame spectral flux
    flux = np.diff(np.maximum(spec, 0), axis=1)
    flux = np.maximum(flux, 0)
    onset_env = np.sum(flux, axis=0)
    onset_env = np.concatenate([[0], onset_env])
    if len(onset_env) > num_frames:
        onset_env = onset_env[:num_frames]

    frames_per_window = max(1, int(WINDOW_SECONDS / HOP_SECONDS))
    onset_std = []
    onset_mean = []
    for i in range(num_frames):
        start = max(0, i - frames_per_window // 2)
        end = min(len(onset_env), i + frames_per_window // 2 + 1)
        window = onset_env[start:end]
        onset_std.append(float(np.std(window)) if len(window) > 1 else 0.0)
        onset_mean.append(float(np.mean(window)) if len(window) else 0.0)

    tempogram_ratio = []
    for i in range(num_frames):
        start = max(0, i - frames_per_window)
        end = min(len(onset_env), i + frames_per_window)
        window = onset_env[start:end]
        if len(window) < 4:
            tempogram_ratio.append(1.0)
            continue
        fft_mag = np.abs(np.fft.rfft(window))
        low_energy = np.sum(fft_mag[:len(fft_mag)//3] ** 2)
        high_energy = np.sum(fft_mag[len(fft_mag)//3:] ** 2) + 1e-10
        tempogram_ratio.append(float(low_energy / high_energy))

    return times, {
        "rms": rms,
        "flatness": flatness,
        "centroid": centroid,
        "rolloff": rolloff,
        "zcr": zcr,
        "onset_std": np.array(onset_std),
        "onset_mean": np.array(onset_mean),
        "tempogram_ratio": np.array(tempogram_ratio),
    }


def _classify_window(raw: dict, idx: int, speech_mask: Optional[np.ndarray] = None) -> str:
    """Classify a single window using acoustic features.

    Conservative approach: only label clear music/applause/silence.
    Everything else defaults to speech.
    """
    rms = raw["rms"][idx]
    flatness = raw["flatness"][idx]
    zcr = raw["zcr"][idx]
    onset_std = raw["onset_std"][idx]

    if rms < 0.005:
        return "silence"

    # Applause: noisy, bursty, broad spectrum
    if rms > 0.03 and flatness > 0.4 and zcr > 0.18 and onset_std > 0.5:
        return "applause"

    # Music: sustained energy + very steady rhythm + tonal (low flatness)
    # Speech has higher onset_std and more variable patterns
    if onset_std < 0.18 and flatness < 0.12 and rms > 0.025:
        return "music"

    # Some music (dense/rock) has higher flatness but still very steady
    if onset_std < 0.12 and rms > 0.035:
        return "music"

    return "speech"


def _smooth_labels(labels: List[str], window_size: int = 3) -> List[str]:
    """Apply majority-vote smoothing to remove spurious short labels."""
    if not labels or window_size <= 1:
        return labels
    half = window_size // 2
    smoothed = []
    for i in range(len(labels)):
        start = max(0, i - half)
        end = min(len(labels), i + half + 1)
        neighbor = labels[start:end]
        # Count votes
        counts = {}
        for lab in neighbor:
            counts[lab] = counts.get(lab, 0) + 1
        # Prefer speech when tied to avoid over-splitting
        best = max(counts, key=lambda k: (counts[k], k == "speech"))
        smoothed.append(best)
    return smoothed


def _build_segments(times: np.ndarray, labels: List[str], duration_s: float) -> List[dict]:
    if not labels:
        return []

    segments = []
    current_label = labels[0]
    start_t = 0.0

    for i in range(1, len(labels)):
        if labels[i] != current_label:
            segments.append({
                "label": current_label,
                "start_ms": int(start_t * 1000),
                "end_ms": int(times[i] * 1000),
            })
            current_label = labels[i]
            start_t = times[i]

    segments.append({
        "label": current_label,
        "start_ms": int(start_t * 1000),
        "end_ms": int(duration_s * 1000),
    })
    return segments


def classify_audio(
    audio_bytes: bytes,
    source_ext: str = "mp3",
    speech_segments: Optional[List[dict]] = None,
) -> List[dict]:
    """Classify audio into speech/music/applause/silence segments."""
    try:
        y = _decode_to_pcm(audio_bytes, source_ext)
    except Exception as e:
        logger.warning("Audio classification decode failed: %s", e)
        return []

    if len(y) < SAMPLE_RATE * 0.5:
        return []

    try:
        times, raw = _frame_features(y)
    except Exception as e:
        logger.warning("Feature extraction failed: %s", e)
        return []

    duration_s = len(y) / SAMPLE_RATE

    speech_mask = None
    if speech_segments:
        speech_mask = np.zeros(len(times), dtype=bool)
        for seg in speech_segments:
            s = seg.get("start_ms", seg.get("start", 0)) / 1000.0
            e = seg.get("end_ms", seg.get("end", 0)) / 1000.0
            for i, t in enumerate(times):
                if s <= t <= e:
                    speech_mask[i] = True

    labels = [_classify_window(raw, i, speech_mask) for i in range(len(times))]
    labels = _smooth_labels(labels, window_size=5)
    segments = _build_segments(times, labels, duration_s)

    # Merge short non-speech segments with neighbors and enforce min duration
    merged = []
    MIN_MUSIC_MS = 1000
    MIN_APPLAUSE_MS = 500
    for seg in segments:
        dur = seg["end_ms"] - seg["start_ms"]
        if seg["label"] == "music" and dur < MIN_MUSIC_MS:
            # Merge into previous or next if possible
            if merged:
                merged[-1]["end_ms"] = seg["end_ms"]
                continue
            else:
                # Will merge with next in post-processing
                pass
        if seg["label"] == "applause" and dur < MIN_APPLAUSE_MS:
            if merged:
                merged[-1]["end_ms"] = seg["end_ms"]
                continue
        merged.append(seg)

    # Second pass: merge any remaining very short segments
    final = []
    for seg in merged:
        if seg["end_ms"] - seg["start_ms"] < 300 and final:
            final[-1]["end_ms"] = seg["end_ms"]
            continue
        final.append(seg)

    logger.info("Audio classification: %d segments", len(final))
    for seg in final:
        logger.debug("  %s %dms-%dms", seg["label"], seg["start_ms"], seg["end_ms"])

    return final


def get_placeholder_label(label: str) -> str:
    if label == "music":
        return "🎵 music"
    if label == "applause":
        return "👏 applause"
    if label == "silence":
        return "🤐 silence"
    return "🤐 silence"


def filter_speech_segments(classified_segments: List[dict]) -> tuple[List[dict], List[dict]]:
    speech = []
    non_speech = []
    for seg in classified_segments:
        if seg["label"] == "speech":
            speech.append({"start_ms": seg["start_ms"], "end_ms": seg["end_ms"]})
        else:
            non_speech.append({
                "start_ms": seg["start_ms"],
                "end_ms": seg["end_ms"],
                "label": seg["label"],
            })
    return speech, non_speech
