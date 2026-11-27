/**
 * ffmpeg 合成收口：动图 GIF / 视频 MP4 / 混音统一走这里（M3-a 自 cards.ts 迁入）。
 *
 * M3-d 内置 ffmpeg：运行时按「安装目录内置副本 → 仓库 vendor 目录 → 系统 PATH」
 * 解析；三处皆无时 hasFfmpeg()=false，调用方（motion/slideshow 入口）给出明确提示。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { TMP_DIR } from "../core/config";
import { log } from "../core/log";

const execFileAsync = promisify(execFile);

export interface MotionCanvasSize {
  width: number;
  height: number;
}

const FFMPEG_BIN = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

let ffmpegCache: string | undefined;

/**
 * 解析 ffmpeg 可执行文件路径：
 *  1) 打包版安装目录 resources/ffmpeg/（extraResources 内置副本）；
 *  2) 仓库开发目录 desktop/vendor/ffmpeg/（dist 前由 ensure-ffmpeg 脚本复制）；
 *  3) 系统 PATH（返回 "ffmpeg" 交给系统解析）。
 * 都没有时返回 "ffmpeg"（调用方以 hasFfmpeg() 判断可用性）。
 */
export function ffmpegPath(): string {
  if (ffmpegCache !== undefined) return ffmpegCache;
  const candidates: string[] = [];
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "ffmpeg", FFMPEG_BIN));
  try {
    // 编译后 __dirname = desktop/dist/render → 上两级即 desktop/
    candidates.push(path.join(__dirname, "..", "..", "vendor", "ffmpeg", FFMPEG_BIN));
  } catch {
    /* __dirname 不可用时跳过仓库候选 */
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        ffmpegCache = candidate;
        return ffmpegCache;
      }
    } catch {
      /* 探测失败继续下一个候选 */
    }
  }
  ffmpegCache = "ffmpeg";
  return ffmpegCache;
}

/** 清除路径解析缓存（冒烟脚本模拟「内置与 PATH 均无 ffmpeg」时使用）。 */
export function resetFfmpegCache(): void {
  ffmpegCache = undefined;
}

/** ffmpeg 是否可用（以 -version 实测，结果缓存）。 */
export async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync(ffmpegPath(), ["-version"]);
    return true;
  } catch {
    return false;
  }
}

/** MP4 输出尺寸：画布 × 0.75 并取偶（yuv420p 要求偶数；1080×1440 → 810×1080 与历史一致）。 */
function mp4Size(canvas: MotionCanvasSize): { w: number; h: number } {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  return { w: even(canvas.width * 0.75), h: even(canvas.height * 0.75) };
}

/** 通用尺寸取偶。 */
function evenSize(canvas: MotionCanvasSize): { w: number; h: number } {
  const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);
  return { w: even(canvas.width), h: even(canvas.height) };
}

/**
 * 图组视频合成（M3-f）：全尺寸 MP4（如 1080×1920），H.264 crf18 faststart。
 * 与 encodeMotion 不同：不产 GIF、不缩放（画布即输出尺寸）。
 */
export async function encodeVideo(
  frames: Buffer[],
  fps: number,
  outFile: string,
  canvas: MotionCanvasSize
): Promise<boolean> {
  const frameDir = path.join(TMP_DIR, `video-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(frameDir, { recursive: true });
    frames.forEach((png, index) =>
      fs.writeFileSync(path.join(frameDir, `f-${String(index).padStart(4, "0")}.png`), png)
    );
    const { w, h } = evenSize(canvas);
    const bin = ffmpegPath();
    await execFileAsync(bin, [
      "-y", "-framerate", String(fps), "-i", path.join(frameDir, "f-%04d.png"),
      "-vf", `scale=${w}:${h}`, "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-crf", "18", "-preset", "medium", "-movflags", "+faststart",
      outFile,
    ]);
    return fs.existsSync(outFile);
  } catch (error) {
    log.warn(`ffmpeg 合成视频失败: ${String(error)}`);
    return false;
  } finally {
    try {
      fs.rmSync(frameDir, { recursive: true, force: true });
    } catch {
      /* 临时帧目录清理失败不影响结果 */
    }
  }
}

/** 探测媒体是否含音频流（ffmpeg -i 的 stderr 文本）。 */
function hasAudioStream(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ["-i", file], (_err, _stdout, stderr) => {
      resolve(/Audio:\s/.test(String(stderr)));
    });
  });
}

/**
 * 混音（M3-g）：视频 + 内置配乐，响度对齐 -14 LUFS（对齐 promo-video 已验证参数）。
 * 源视频含音轨 → amix 合成；源视频无声（我们生成的 MP4）→ 配乐直接作为音轨。
 * 视频流直拷（-c:v copy），音频压 AAC。失败由调用方按「保留无声视频」处理。
 */
export async function mixAudio(video: string, bgm: string, outFile: string): Promise<boolean> {
  try {
    const bin = ffmpegPath();
    const withSourceAudio = await hasAudioStream(video);
    const filter = withSourceAudio
      ? "[1:a]volume=0.25[b];[0:a][b]amix=duration=first[am];[am]loudnorm=I=-14:TP=-1.5[out]"
      : "[1:a]volume=0.25,loudnorm=I=-14:TP=-1.5[out]";
    await execFileAsync(bin, [
      "-y", "-i", video, "-i", bgm,
      "-filter_complex", filter,
      "-map", "0:v", "-map", "[out]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
      outFile,
    ]);
    return fs.existsSync(outFile);
  } catch (error) {
    log.warn(`ffmpeg 混音失败: ${String(error)}`);
    return false;
  }
}

/**
 * ffmpeg 合成动图：loop.gif（15fps / 540 宽 / 两阶段调色板）+ motion.mp4（H.264 crf18）。
 * 任一产物缺失视为失败（调用方回退静态首帧）。返回 true 表示两个产物都已写出。
 */
export async function encodeMotion(
  frames: Buffer[],
  fps: number,
  outDir: string,
  canvas: MotionCanvasSize = { width: 1080, height: 1440 }
): Promise<boolean> {
  const frameDir = path.join(TMP_DIR, `motion-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(frameDir, { recursive: true });
    frames.forEach((png, index) =>
      fs.writeFileSync(path.join(frameDir, `f-${String(index).padStart(4, "0")}.png`), png)
    );
    const bin = ffmpegPath();
    await execFileAsync(bin, [
      "-y", "-framerate", String(fps), "-i", path.join(frameDir, "f-%04d.png"),
      "-vf",
      "fps=15,scale=540:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
      path.join(outDir, "loop.gif"),
    ]);
    const { w, h } = mp4Size(canvas);
    await execFileAsync(bin, [
      "-y", "-framerate", String(fps), "-i", path.join(frameDir, "f-%04d.png"),
      "-vf", `scale=${w}:${h}`, "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-crf", "18", "-preset", "medium", "-movflags", "+faststart",
      path.join(outDir, "motion.mp4"),
    ]);
    return (
      fs.existsSync(path.join(outDir, "loop.gif")) &&
      fs.existsSync(path.join(outDir, "motion.mp4"))
    );
  } catch (error) {
    log.warn(`ffmpeg 合成动图失败: ${String(error)}`);
    return false;
  } finally {
    try {
      fs.rmSync(frameDir, { recursive: true, force: true });
    } catch {
      /* 临时帧目录清理失败不影响结果 */
    }
  }
}
