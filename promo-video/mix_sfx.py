"""在保留原音轨（BGM 已烘焙）的基础上，按 cue 表混入 SFX。
用法: python mix_sfx.py <in.mp4> <cues.tsv> <out.mp4>
"""
import subprocess
import sys
from pathlib import Path

SFX_DIR = Path(r"C:\Users\徐豪\.trae-cn\skills\huashu-design\assets\sfx")

inp, table, out = sys.argv[1], sys.argv[2], sys.argv[3]

probe = subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inp],
    capture_output=True, text=True, check=True)
dur = float(probe.stdout.strip())
# 音频流是否存在
streams = subprocess.run(
    ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
     "-of", "csv=p=0", inp], capture_output=True, text=True, check=True)
has_audio = bool(streams.stdout.strip())

cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", inp]
filters = []
mix = ""
idx = 1
if has_audio:
    filters.append("[0:a]anull[base]")
    mix = "[base]"
for line in Path(table).read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    t, f, db = line.split("\t")
    sfx = SFX_DIR / f
    if not sfx.exists():
        sys.exit(f"SFX 不存在: {sfx}")
    cmd += ["-i", str(sfx)]
    ms = int(float(t) * 1000)
    filters.append(f"[{idx}:a]adelay={ms}:all=1,volume={db}dB[s{idx}]")
    mix += f"[s{idx}]"
    idx += 1
n = idx - (1 if has_audio else 0)
if n == 0:
    sys.exit("cue 表为空")
filters.append(f"{mix}amix=inputs={idx}:normalize=0,apad=whole_dur={dur}[aout]")

cmd += ["-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out]
subprocess.run(cmd, check=True)
print(f"OK: {n} cues + bgm -> {out}")
