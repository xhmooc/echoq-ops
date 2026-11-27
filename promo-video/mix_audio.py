"""把 BGM 与 SFX cue 表混入（无声）视频。
用法: python mix_audio.py <in.mp4> <cues.tsv> <bgm.mp3> <out.mp4> [总时长秒]
BGM: 裁到片长、0.6s 淡入、1.8s 淡出、音量 0.85；SFX 按 cue 表 adelay + dB 增益；amix 合成。
"""
import subprocess
import sys
from pathlib import Path

SFX_DIR = Path(r"C:\Users\徐豪\.trae-cn\skills\huashu-design\assets\sfx")

def find_sfx(name: str) -> Path:
    hits = list(SFX_DIR.rglob(name))
    if not hits:
        sys.exit(f"SFX 不存在: {name} (在 {SFX_DIR} 下递归查找失败)")
    return hits[0]

inp, table, bgm, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
dur = float(sys.argv[5]) if len(sys.argv) > 5 else None

if dur is None:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", inp],
        capture_output=True, text=True, check=True)
    dur = float(probe.stdout.strip())

cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", inp, "-i", bgm]
filters = [f"[1:a]atrim=0:{dur:.3f},afade=t=in:st=0:d=0.6,"
           f"afade=t=out:st={max(0.0, dur - 1.8):.3f}:d=1.8,volume=0.85[bgm]"]
mix = "[bgm]"
idx = 2
for line in Path(table).read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    t, f, db = line.split("\t")
    sfx = find_sfx(f)
    cmd += ["-i", str(sfx)]
    ms = int(float(t) * 1000)
    filters.append(f"[{idx}:a]adelay={ms}:all=1,volume={db}dB[s{idx}]")
    mix += f"[s{idx}]"
    idx += 1
filters.append(f"{mix}amix=inputs={idx-1}:normalize=0,"
                f"loudnorm=I=-14:TP=-1.5:LRA=11,apad=whole_dur={dur:.3f}[aout]")

cmd += ["-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[aout]",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out]
subprocess.run(cmd, check=True)
print(f"OK: bgm + {idx-2} cues -> {out}")
