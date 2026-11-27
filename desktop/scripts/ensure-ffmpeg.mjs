/**
 * 打包前准备：确保 desktop/vendor/ffmpeg/ 里有 ffmpeg.exe（M3-d 内置 ffmpeg）。
 *
 * 策略：目录里已有就直接用；没有则从系统 PATH 复制一份；PATH 也没有就放一个
 * 说明文件占位（extraResources 需要源目录存在）。运行时 ffmpegPath() 按
 * 「安装目录内置副本 → 仓库 vendor 目录 → 系统 PATH」解析，都没有时动图入口
 * 给出明确提示。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "..", "vendor", "ffmpeg");
const target = path.join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

fs.mkdirSync(dir, { recursive: true });

if (fs.existsSync(target)) {
  console.log(`[ensure-ffmpeg] 已存在：${target}`);
} else {
  let source = "";
  try {
    const out = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["ffmpeg"], { encoding: "utf8" });
    source = String(out).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  } catch {
    source = "";
  }
  if (source && fs.existsSync(source)) {
    fs.copyFileSync(source, target);
    console.log(`[ensure-ffmpeg] 已从系统 PATH 复制内置 ffmpeg：${source} -> ${target}`);
  } else {
    const note = path.join(dir, "README.txt");
    fs.writeFileSync(
      note,
      "未在本机找到 ffmpeg，安装包将不内置 ffmpeg。\n" +
      "运行时会回落系统 PATH；若用户机器也没有 ffmpeg，动图/视频入口会给出明确提示。\n" +
      "可在打包前手动放置 ffmpeg.exe 到本目录，或运行 `where ffmpeg` 确认系统安装。\n",
      "utf8"
    );
    console.warn("[ensure-ffmpeg] 警告：未找到 ffmpeg，安装包将不内置（回落系统 PATH）");
  }
}
