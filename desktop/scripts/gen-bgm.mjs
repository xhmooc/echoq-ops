/**
 * M3-g 内置配乐生成（自研代码合成，免版权）：
 * `node scripts/gen-bgm.mjs` —— 纯 JS 合成三段短 loop（约 16~20s，mono 44.1kHz），
 * 再用 ffmpeg 压成 AAC（目标单条 ≤100KB），落到 desktop/vendor/bgm/。
 *
 * 确定性：全部用数学振荡器 + 固定音符表，不使用随机数——同代码同输出。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "..", "vendor", "bgm");
fs.mkdirSync(outDir, { recursive: true });

const SR = 44100;

/** 解析 ffmpeg：优先仓库 vendor 副本，回落系统 PATH。 */
function ffmpegBin() {
  const vendor = path.join(here, "..", "vendor", "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(vendor)) return vendor;
  return "ffmpeg";
}

function midi(n) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

function makeBuffer(seconds) {
  return new Float32Array(Math.floor(SR * seconds));
}

/** 叠加一个带包络的振荡音符。 */
function addTone(buf, { freq, t0, dur, gain = 0.2, type = "sine", attack = 0.01, decay = 0.3 }) {
  const start = Math.floor(t0 * SR);
  const len = Math.floor(dur * SR);
  for (let i = 0; i < len; i += 1) {
    const t = i / SR;
    const env = Math.min(1, t / attack) * Math.exp(-t / decay);
    let v;
    if (type === "triangle") {
      v = 2 * Math.abs(2 * ((t * freq) % 1) - 1) - 1;
    } else if (type === "square") {
      v = Math.sign(Math.sin(2 * Math.PI * freq * t)) * 0.55;
    } else {
      v = Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(4 * Math.PI * freq * t);
    }
    const idx = start + i;
    if (idx >= 0 && idx < buf.length) buf[idx] += v * env * gain;
  }
}

/** 底鼓：150→45Hz 正弦扫频 + 指数衰减。 */
function addKick(buf, t0, gain = 0.5) {
  const start = Math.floor(t0 * SR);
  const len = Math.floor(0.16 * SR);
  for (let i = 0; i < len; i += 1) {
    const t = i / SR;
    const freq = 45 + 115 * Math.exp(-t * 26);
    const idx = start + i;
    if (idx >= 0 && idx < buf.length) buf[idx] += Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 18) * gain;
  }
}

/** 踩镲：带通感噪声短促衰减。 */
function addHat(buf, t0, gain = 0.06) {
  const start = Math.floor(t0 * SR);
  const len = Math.floor(0.05 * SR);
  let seed = Math.floor(t0 * 9973) + 7;
  for (let i = 0; i < len; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff) * 2 - 1;
    const t = i / SR;
    const idx = start + i;
    if (idx >= 0 && idx < buf.length) buf[idx] += noise * Math.exp(-t * 90) * gain;
  }
}

/** 峰值归一到 0.5，写 16bit 单声道 WAV。 */
function writeWav(buf, file) {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? 0.5 / peak : 1;
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i += 1) {
    data.writeInt16LE(Math.round(buf[i] * scale * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24);
  header.writeUInt32LE(SR * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

/* ---------------- 曲目一：sunrise 晨光（轻快木琴感，C 大调五声） ---------------- */
function trackSunrise() {
  const bpm = 112;
  const beat = 60 / bpm;
  const bars = 8;
  const buf = makeBuffer(bars * 4 * beat + 1.2);
  const roots = [48, 43, 45, 41]; // C3 G2 A2 F2
  const arps = [
    [60, 64, 67, 64, 60, 64, 67, 69],
    [55, 59, 62, 59, 55, 59, 62, 67],
    [57, 60, 64, 60, 57, 60, 64, 69],
    [53, 57, 60, 57, 53, 57, 60, 65],
  ];
  for (let bar = 0; bar < bars; bar += 1) {
    const t0 = bar * 4 * beat;
    const chord = bar % 4;
    addTone(buf, { freq: midi(roots[chord]), t0, dur: 4 * beat, gain: 0.16, type: "triangle", attack: 0.02, decay: 2.2 });
    for (let eighth = 0; eighth < 8; eighth += 1) {
      const t = t0 + eighth * beat * 0.5;
      addTone(buf, { freq: midi(arps[chord][eighth]), t0: t, dur: 0.4, gain: 0.17, type: "sine", attack: 0.004, decay: 0.16 });
      addHat(buf, t + beat * 0.25, 0.045);
    }
  }
  return buf;
}

/* ---------------- 曲目二：cloud 云层（舒缓氛围，Am7-Fmaj7-Cmaj7-G6） ---------------- */
function trackCloud() {
  const bpm = 84;
  const beat = 60 / bpm;
  const bars = 6;
  const buf = makeBuffer(bars * 4 * beat + 1.6);
  const chords = [
    [57, 60, 64, 67], // Am7
    [53, 57, 60, 64], // Fmaj7
    [48, 52, 55, 59], // Cmaj7
    [55, 59, 62, 64], // G6
  ];
  const melody = [76, 79, 81, 79, 76, 74]; // E5 G5 A5 …
  for (let bar = 0; bar < bars; bar += 1) {
    const t0 = bar * 4 * beat;
    const chord = chords[bar % 4];
    for (const note of chord) {
      addTone(buf, { freq: midi(note), t0, dur: 4 * beat, gain: 0.09, type: "sine", attack: 0.5, decay: 3.2 });
    }
    if (bar < melody.length) {
      addTone(buf, { freq: midi(melody[bar]), t0: t0 + beat, dur: 2.4, gain: 0.13, type: "sine", attack: 0.03, decay: 1.6 });
    }
  }
  return buf;
}

/* ---------------- 曲目三：spark 火花（活力节奏，A 小调） ---------------- */
function trackSpark() {
  const bpm = 126;
  const beat = 60 / bpm;
  const bars = 8;
  const buf = makeBuffer(bars * 4 * beat + 1.0);
  const arp = [69, 72, 76, 72, 69, 72, 76, 79]; // A4 C5 E5 …
  const bassNotes = [45, 45, 41, 43]; // A2 A2 F2 G2
  for (let bar = 0; bar < bars; bar += 1) {
    const t0 = bar * 4 * beat;
    for (let b = 0; b < 4; b += 1) {
      addKick(buf, t0 + b * beat, 0.42);
      addHat(buf, t0 + b * beat + beat * 0.5, 0.07);
    }
    for (let sixteenth = 0; sixteenth < 16; sixteenth += 1) {
      const t = t0 + sixteenth * beat * 0.25;
      const note = arp[(sixteenth + bar) % arp.length];
      addTone(buf, { freq: midi(note), t0: t, dur: 0.18, gain: 0.085, type: "square", attack: 0.002, decay: 0.1 });
    }
    addTone(buf, { freq: midi(bassNotes[bar % 4]), t0, dur: beat * 3.6, gain: 0.2, type: "triangle", attack: 0.01, decay: 1.4 });
  }
  return buf;
}

/* ---------------- 编码输出 ---------------- */
const tracks = [
  { key: "sunrise", name: "晨光 · 轻快", render: trackSunrise },
  { key: "cloud", name: "云层 · 舒缓", render: trackCloud },
  { key: "spark", name: "火花 · 活力", render: trackSpark },
];

const bin = ffmpegBin();
let ffmpegReady = true;
try {
  execFileSync(bin, ["-version"], { stdio: "ignore" });
} catch {
  ffmpegReady = false;
}
if (!ffmpegReady) {
  fs.writeFileSync(
    path.join(outDir, "README.txt"),
    "构建机未找到 ffmpeg，未生成内置配乐；运行时会回落系统 PATH，动图/视频入口在缺失时给出明确提示。\n",
    "utf8"
  );
  console.warn("[gen-bgm] 警告：未找到 ffmpeg，跳过配乐生成");
  process.exit(0);
}
for (const track of tracks) {
  const wav = path.join(outDir, `${track.key}.wav`);
  const m4a = path.join(outDir, `${track.key}.m4a`);
  writeWav(track.render(), wav);
  execFileSync(bin, ["-y", "-i", wav, "-codec:a", "aac", "-b:a", "40k", "-ac", "1", m4a], { stdio: "ignore" });
  fs.rmSync(wav, { force: true });
  const size = fs.statSync(m4a).size;
  console.log(`[gen-bgm] ${track.key}.m4a ${(size / 1024).toFixed(0)}KB ${size <= 100 * 1024 ? "≤100KB ✓" : "超预算 ✗"}`);
}
console.log("[gen-bgm] 完成");
