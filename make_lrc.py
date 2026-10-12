"""
make_lrc.py — Generate a synced .lrc file from an audio file + lyrics text.

Usage:
    python make_lrc.py <audio_file> <lyrics_file> [output.lrc]

Arguments:
    audio_file   Path to the audio file (mp3, wav, flac, m4a, etc.)
    lyrics_file  Plain text file with one lyric line per line.
                 Blank lines between verses are preserved as blank LRC lines.
    output.lrc   Optional output path. Defaults to <audio_file_stem>.lrc
                 in the same folder as the audio file.

Requires:
    pip install faster-whisper

How it works:
    1. Runs faster-whisper (medium model, VAD) on the audio to get segments.
    2. Reads the lyrics file — non-blank lines are the lines to timestamp.
    3. Maps segments to lyric lines 1:1 (if counts match) or by interpolation.
    4. Writes the .lrc file with [mm:ss.xx] timestamps.

LRC metadata tags (optional) — add these as the first lines of the lyrics file:
    [ti:Song Title]
    [ar:Artist Name]
    [al:Album Name]
    Any line starting with [ and matching the tag pattern is treated as metadata.

Example lyrics file (Hanuman_Chalisa.txt):
    [ti:Hanuman Chalisa]
    [ar:Tulsidas]

    Line one of verse 1
    Line two of verse 1

    Line one of verse 2
    ...
"""

import sys
import os

def fmt(s):
    m = int(s // 60)
    sec = s % 60
    return f"[{m:02d}:{sec:05.2f}]"

def run_whisper(audio_path):
    from faster_whisper import WhisperModel
    print(f"Loading faster-whisper medium model...", flush=True)
    model = WhisperModel("medium", device="cpu", compute_type="int8")
    print(f"Transcribing {os.path.basename(audio_path)}...", flush=True)
    segs, info = model.transcribe(
        audio_path,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 600},
        word_timestamps=False,
    )
    segments = list(segs)
    print(f"  Duration: {info.duration:.1f}s | Language: {info.language} | Segments: {len(segments)}")
    return segments

def read_lyrics(lyrics_path):
    with open(lyrics_path, encoding="utf-8") as f:
        raw = f.read()
    meta_lines = []
    lyric_lines = []   # non-blank, non-meta
    blank_after = []   # indices in lyric_lines after which a blank should appear

    import re
    meta_re = re.compile(r'^\[[a-zA-Z]+:.+\]$')

    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            if lyric_lines:
                blank_after.append(len(lyric_lines) - 1)
        elif meta_re.match(stripped):
            meta_lines.append(stripped)
        else:
            lyric_lines.append(stripped)

    return meta_lines, lyric_lines, blank_after

def map_segments_to_lyrics(segments, lyric_lines):
    n_seg = len(segments)
    n_lyr = len(lyric_lines)
    print(f"  Segments: {n_seg} | Lyric lines: {n_lyr}")
    if n_seg == 0:
        raise RuntimeError("Whisper returned no segments — check the audio file.")

    times = []
    if n_seg >= n_lyr:
        # 1:1 — use first n_lyr segment starts
        for i in range(n_lyr):
            times.append(segments[i].start)
    else:
        # Interpolate segment starts across lyric lines
        for i in range(n_lyr):
            idx = i * (n_seg - 1) / max(n_lyr - 1, 1)
            lo = int(idx)
            hi = min(lo + 1, n_seg - 1)
            frac = idx - lo
            t = segments[lo].start * (1 - frac) + segments[hi].start * frac
            times.append(t)
    return times

def build_lrc(meta_lines, lyric_lines, blank_after, times, output_path):
    lines = list(meta_lines) + [""]
    blank_set = set(blank_after)
    for i, (t, lyr) in enumerate(zip(times, lyric_lines)):
        lines.append(f"{fmt(t)}{lyr}")
        if i in blank_set:
            lines.append("")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"Written: {output_path}")

def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    audio_path = sys.argv[1]
    lyrics_path = sys.argv[2]
    if len(sys.argv) >= 4:
        output_path = sys.argv[3]
    else:
        stem = os.path.splitext(os.path.basename(audio_path))[0]
        output_path = os.path.join(os.path.dirname(audio_path), stem + ".lrc")

    if not os.path.exists(audio_path):
        print(f"Error: audio file not found: {audio_path}")
        sys.exit(1)
    if not os.path.exists(lyrics_path):
        print(f"Error: lyrics file not found: {lyrics_path}")
        sys.exit(1)

    segments = run_whisper(audio_path)
    meta_lines, lyric_lines, blank_after = read_lyrics(lyrics_path)

    if not lyric_lines:
        print("Error: no lyric lines found in lyrics file.")
        sys.exit(1)

    times = map_segments_to_lyrics(segments, lyric_lines)
    build_lrc(meta_lines, lyric_lines, blank_after, times, output_path)

if __name__ == "__main__":
    main()
