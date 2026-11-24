/**
 * M1 V2 冒烟脚本（临时，不进安装包的功能路径）：
 * 编译后用 `npx electron dist/smoke.js` 运行，
 * 验证 V2 模板 → Electron 隐藏窗口截图 → 版式体检 全链路。
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { captureFrames, captureHtml, captureHtmlWithProbe, checkBlocks } from "./render/renderer";
import { renderCardDocument, type CardPalette } from "./render/templates";
import { renderV2Document } from "./render/v2templates";
import type { CardPage } from "./render/templates";

const OUT = path.join(__dirname, "..", ".smoke-out");

function page(partial: Partial<CardPage>): CardPage {
  return {
    kind: "content",
    index: 2,
    total: 6,
    title: "3 个让笔记更清晰的方法",
    subtitle: "把注意力花在结构上，而不是堆辞藻",
    section: "大标题只说一件事",
    sectionIcon: "✨",
    items: [
      { icon: "✅", text: "一眼就知道这篇讲什么" },
      { icon: "✅", text: "不贪多，一页一个重点" },
      { icon: "✅", text: "条目控制在两行以内" },
    ],
    toc: [
      { label: "大标题只说一件事", page: 2 },
      { label: "每页最多三个要点", page: 3 },
      { label: "留白也是信息", page: 4 },
    ],
    tags: ["知识卡片", "步骤清单", "数据信息图"],
    ...partial,
  } as CardPage;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const results: Array<Record<string, unknown>> = [];

  // 1) 竖版封面：知识卡片 / 上下图文
  const cover = renderV2Document(page({ kind: "cover", index: 1 }), "knowledge", "stack", "default", 1080, 1440);
  const r1 = await captureHtmlWithProbe(cover, 1080, 1440);
  const c1 = checkBlocks(r1.blocks, 1080, 1440);
  fs.writeFileSync(path.join(OUT, "v2-knowledge-stack-cover.png"), r1.png);
  results.push({ name: "knowledge/stack cover", bytes: r1.png.length, blocks: r1.blocks.length, first: r1.blocks[0] || null, errors: c1.errors, warnings: c1.warnings.length });
  if (r1.png.length < 20000) throw new Error("封面 PNG 过小");
  if (c1.errors.length) throw new Error(`体检 errors：${c1.errors.join("；")}`);

  // 2) 竖版内容页：大字公告 / 单图大标题 / 暖调
  const content = renderV2Document(page({ kind: "content" }), "poster", "hero", "warm", 1080, 1440);
  const r2 = await captureHtmlWithProbe(content, 1080, 1440);
  const c2 = checkBlocks(r2.blocks, 1080, 1440);
  fs.writeFileSync(path.join(OUT, "v2-poster-hero-content.png"), r2.png);
  results.push({ name: "poster/hero content", bytes: r2.png.length, blocks: r2.blocks.length, errors: c2.errors, warnings: c2.warnings.length });
  if (r2.png.length < 20000) throw new Error("内容页 PNG 过小");

  // 3) 公众号宽幅封面：步骤清单 / 长图分页 / 冷调
  const wide = renderV2Document(page({ kind: "cover", index: 1 }), "steps", "strip", "cool", 1080, 460);
  const r3 = await captureHtml(wide, 1080, 460);
  fs.writeFileSync(path.join(OUT, "v2-steps-strip-wide.png"), r3);
  results.push({ name: "steps/strip wide", bytes: r3.length });
  if (r3.length < 10000) throw new Error("宽幅 PNG 过小");

  // 4) 动效逐帧管线：memo/sparse motion 页，__seek(0/3/5.96) 三帧必须互不相同
  const brand = { brand: "EchoQ", column: "实用信息流", issue: "第 1 期" };
  const motionHtml = renderCardDocument(page({ kind: "cover", index: 1 }), {
    style: "memo",
    palette: "default" as unknown as CardPalette,
    brand,
    layout: "sparse",
    width: 1080,
    height: 1440,
    motion: true,
  });
  const frames = await captureFrames(motionHtml, 1080, 1440, [0, 3, 5.96]);
  fs.writeFileSync(path.join(OUT, "motion-frame-0.png"), frames[0]);
  fs.writeFileSync(path.join(OUT, "motion-frame-2.png"), frames[2]);
  if (frames[0].equals(frames[2])) throw new Error("动效帧完全相同，__seek 未生效");
  results.push({ name: "motion frames", frames: frames.length, bytes: frames.map((f) => f.length) });

  console.log(`SMOKE ${JSON.stringify(results)}`);
}

app.whenReady().then(
  async () => {
    try {
      await main();
      console.log("SMOKE OK");
      app.exit(0);
    } catch (error) {
      console.error(`SMOKE FAIL: ${String(error)}`);
      app.exit(1);
    }
  },
  (error) => {
    console.error(`SMOKE FAIL (app ready): ${String(error)}`);
    app.exit(1);
  }
);
