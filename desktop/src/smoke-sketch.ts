/**
 * M2 手绘引擎冒烟脚本（临时，不进安装包的功能路径）：
 * 编译后用 `npx electron dist/smoke-sketch.js` 运行，
 * 验证 sketch 模板 → Electron 隐藏窗口截图 → 版式体检 → 种子可复现 全链路。
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { captureHtml, captureHtmlWithProbe, checkBlocks } from "./render/renderer";
import { renderSketchDocument, sketchSeed, SKETCH_STYLES } from "./render/sketch";
import type { CardPage } from "./render/templates";

const OUT = path.join(__dirname, "..", ".smoke-out");

function page(partial: Partial<CardPage>): CardPage {
  return {
    kind: "cover",
    index: 1,
    total: 6,
    title: "3 个让笔记更清晰的方法",
    subtitle: "把注意力花在结构上，而不是堆辞藻",
    section: "大标题只说一件事",
    sectionIcon: "✨",
    items: [
      { icon: "✅", text: "一眼就知道这篇讲什么" },
      { icon: "✅", text: "不贪多，一页一个重点" },
      { icon: "✅", text: "条目控制在两行以内" },
      { icon: "✅", text: "手绘插画配实用内容" },
    ],
    toc: [
      { label: "大标题只说一件事", page: 2 },
      { label: "每页最多三个要点", page: 3 },
    ],
    tags: ["手绘插画", "平涂向量", "水墨国风"],
    ...partial,
  } as CardPage;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const results: Array<Record<string, unknown>> = [];

  // 1) 五种风格 × 封面页：截图 + 体检必须零 errors
  for (const style of SKETCH_STYLES) {
    const html = renderSketchDocument(page({}), style.key, 42, 1080, 1440);
    const r = await captureHtmlWithProbe(html, 1080, 1440);
    const c = checkBlocks(r.blocks, 1080, 1440);
    fs.writeFileSync(path.join(OUT, `sketch-${style.key}-cover.png`), r.png);
    results.push({
      name: `${style.key} cover`,
      bytes: r.png.length,
      blocks: r.blocks.length,
      errors: c.errors,
      warnings: c.warnings.length,
    });
    if (r.png.length < 20000) throw new Error(`${style.key} 封面 PNG 过小`);
    if (c.errors.length) throw new Error(`${style.key} 体检 errors：${c.errors.join("；")}`);
  }

  // 2) 种子可复现：同 seed 渲染两遍逐字节一致
  const htmlA = renderSketchDocument(page({}), "sk-flat", 42, 1080, 1440);
  const pngA1 = await captureHtml(htmlA, 1080, 1440);
  const pngA2 = await captureHtml(htmlA, 1080, 1440);
  if (!pngA1.equals(pngA2)) throw new Error("同 seed 两次渲染不一致（确定性被破坏）");
  results.push({ name: "same-seed identical", bytes: pngA1.length });

  // 3) 换一张：variant 变化 → seed 变化 → 画面不同
  const seed0 = sketchSeed(7, 0);
  const seed1 = sketchSeed(7, 1);
  if (seed0 === seed1) throw new Error("variant 派生种子未变化");
  const htmlB = renderSketchDocument(page({}), "sk-flat", seed1, 1080, 1440);
  const pngB = await captureHtml(htmlB, 1080, 1440);
  if (pngA1.equals(pngB)) throw new Error("换 seed 后画面完全相同");
  fs.writeFileSync(path.join(OUT, "sketch-flat-variant1.png"), pngB);
  results.push({ name: "variant differs", seed0, seed1 });

  // 4) 内容页 / 结尾页 / 公众号宽幅
  const content = renderSketchDocument(page({ kind: "content", index: 2 }), "sk-sumie", 42, 1080, 1440);
  const rContent = await captureHtmlWithProbe(content, 1080, 1440);
  const cContent = checkBlocks(rContent.blocks, 1080, 1440);
  fs.writeFileSync(path.join(OUT, "sketch-sumie-content.png"), rContent.png);
  if (cContent.errors.length) throw new Error(`sumie content 体检 errors：${cContent.errors.join("；")}`);

  const ending = renderSketchDocument(page({ kind: "ending", index: 6, total: 6 }), "sk-marker", 42, 1080, 1440);
  const rEnding = await captureHtmlWithProbe(ending, 1080, 1440);
  const cEnding = checkBlocks(rEnding.blocks, 1080, 1440);
  fs.writeFileSync(path.join(OUT, "sketch-marker-ending.png"), rEnding.png);
  if (cEnding.errors.length) throw new Error(`marker ending 体检 errors：${cEnding.errors.join("；")}`);

  const wide = renderSketchDocument(page({}), "sk-cutpaper", 42, 1080, 460);
  const rWide = await captureHtml(wide, 1080, 460);
  fs.writeFileSync(path.join(OUT, "sketch-cutpaper-wide.png"), rWide);
  if (rWide.length < 10000) throw new Error("宽幅 PNG 过小");
  results.push({ name: "content/ending/wide", content: rContent.png.length, ending: rEnding.png.length, wide: rWide.length });

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
