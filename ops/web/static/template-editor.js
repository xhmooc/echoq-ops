/* ================================================================
   M3 自定义出图模板编辑器（view-templates）
   由 design-lab/template-editor 原型移植：
   - 保存从 localStorage 改为 /api/templates（custom_templates 表）
   - 官方模板库保持前端内置示例（与主线模板清单对齐）
   - 双击官方模板页型 = 以该页开始编辑；元素级 Ctrl+C/V 跨模板复制
   模板 schema：{ pages: { cover, content, ending: { canvas, elements[] } } }
   ================================================================ */
/* global api */

const TED_PAGE_TYPES = [
  { key: "cover", name: "首页" },
  { key: "content", name: "内容页" },
  { key: "ending", name: "末页" },
];

const tedState = {
  templateId: null, /* 当前编辑的模板 id（null = 未保存的新模板） */
  pages: {
    cover: { canvas: { w: 1080, h: 1440 }, elements: [] },
    content: { canvas: { w: 1080, h: 1440 }, elements: [] },
    ending: { canvas: { w: 1080, h: 1440 }, elements: [] },
  },
  currentPage: "cover",
  selectedId: null,
  multiSel: new Set(),
  editingId: null,
  clipboard: [],
  browse: null, /* { tpl, page } 浏览官方模板页（可选中复制，不可编辑） */
  history: [],
  future: [],
  scale: 1,
  loaded: false,
};

/* ---------------- 官方模板（与主线 render/ 的模板清单对齐） ---------------- */
const TED_OFFICIAL_GROUPS = [
  {
    group: "实用信息流",
    templates: [
      { key: "knowledge", name: "知识卡片", en: "Knowledge", colors: ["#FAF7F0", "#1F2937", "#2563EB"], layout: "card", deco: "paper" },
      { key: "steps", name: "步骤清单", en: "Steps", colors: ["#FFFFFF", "#17181C", "#F97316"], layout: "steps", deco: "paper" },
      { key: "datachart", name: "数据信息图", en: "Data", colors: ["#F8FAF9", "#0F172A", "#0E9F6E"], layout: "chart", deco: "chart" },
      { key: "versus", name: "对比测评", en: "Versus", colors: ["#FDFDFB", "#111827", "#EA580C"], layout: "versus", deco: "paper" },
      { key: "poster", name: "大字公告", en: "BigType", colors: ["#111318", "#FFFFFF", "#FFD447"], layout: "poster", deco: "spark" },
      { key: "caption", name: "图注解读", en: "Caption", colors: ["#F5F5F2", "#2D2A26", "#8A8F98"], layout: "caption", deco: "paper" },
    ],
  },
  {
    group: "手绘插画",
    templates: [
      { key: "sk-flat", name: "平涂向量", en: "Flat", colors: ["#FDF6EC", "#3A3631", "#F4A83C"], layout: "illust", deco: "flat" },
      { key: "sk-pencil", name: "铅笔淡彩", en: "Pencil", colors: ["#FBF7EE", "#4A4A46", "#E9A23B"], layout: "illust", deco: "pencil" },
      { key: "sk-marker", name: "马克漫画", en: "Marker", colors: ["#FFFFFF", "#17181C", "#FF5D73"], layout: "illust", deco: "marker" },
      { key: "sk-sumie", name: "水墨国风", en: "Sumie", colors: ["#F7F4EC", "#2B2723", "#B03A2E"], layout: "illust", deco: "sumie" },
      { key: "sk-cutpaper", name: "剪纸节日", en: "CutPaper", colors: ["#FBF3E4", "#5C1A16", "#C8392B"], layout: "illust", deco: "cutpaper" },
    ],
  },
];

/* 官方模板一律用真实出图样张（与出图引擎同源），没有样张的风格不上架 */
function tedSampleUrl(tpl, page) {
  if (!tpl || !tpl.key) return "";
  const kind = page || "cover";
  if (tpl.key.startsWith("sk-")) return `/designs/samples/${tpl.key}-${kind}.png`;
  return `/designs/samples/${tpl.key}-page-${kind}.png`;
}

/* 样张由后端按需生成（缺失的页型首次进入模板页时补齐） */
let tedSamplesReady = false;
async function ensureOfficialSamples() {
  if (tedSamplesReady) return;
  tedSamplesReady = true;
  try {
    await api("/api/design/samples");
    tedRenderOfficialList();
  } catch (e) {
    tedSamplesReady = false;
  }
}

/* 风格纹样：确定性伪随机生成 SVG，让每个风格带上自己的笔触与肌理，
   而不是所有模板共用同一套色块骨架。 */
function tedDecoSvg(variant, colors, seedInput) {
  const ink = colors[1];
  const accent = colors[2];
  const seed = String(seedInput || "deco")
    .split("")
    .reduce((sum, ch) => sum + ch.charCodeAt(0), 7);
  const px = (i, mod = 100) => {
    const v = Math.sin(seed * 9.17 + i * 12.9898) * 43758.5453;
    return Math.round((((v % 1) + 1) % 1) * mod);
  };
  const stroke = (d, color, width, opacity, dash) =>
    '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + width +
    '" stroke-linecap="round" opacity="' + opacity + '"' +
    (dash ? ' stroke-dasharray="' + dash + '"' : "") + "/>";
  const curve = (i, color, width = 1, opacity = 0.3, dash = "") =>
    stroke(
      "M" + (px(i) - 10) + " " + px(i + 1) + " Q" + px(i + 2) + " " + px(i + 3) +
        "," + px(i + 4) + " " + px(i + 5),
      color,
      width,
      opacity,
      dash
    );
  let art = "";
  if (variant === "pencil") {
    art =
      Array.from({ length: 9 }, (_, i) => curve(i * 3, ink, 0.6 + px(i, 8) / 10, 0.16 + px(i + 1, 26) / 100)).join("") +
      Array.from({ length: 4 }, (_, i) => curve(40 + i * 3, accent, 1.6, 0.34)).join("");
  } else if (variant === "watercolor") {
    const id = "wc" + seed;
    art =
      '<defs><filter id="' + id + '" x="-30%" y="-30%" width="160%" height="160%">' +
      '<feGaussianBlur stdDeviation="6"/></filter></defs>' +
      [0, 1, 2, 3]
        .map(
          (i) =>
            '<ellipse cx="' + px(i * 4) + '" cy="' + px(i * 4 + 1) + '" rx="' + (10 + px(i, 14)) +
            '" ry="' + (8 + px(i + 1, 12)) + '" fill="' + (i % 2 ? ink : accent) +
            '" opacity="' + (0.18 + px(i + 2, 16) / 100) + '" filter="url(#' + id + ')"/>'
        )
        .join("") +
      curve(60, ink, 1, 0.3) +
      curve(63, accent, 0.9, 0.4);
  } else if (variant === "sumie") {
    art =
      [0, 1, 2]
        .map(
          (i) =>
            '<path d="M' + (px(i * 5) - 5) + " " + px(i * 5 + 1) + " C" + px(i * 5 + 2) + " " +
            px(i * 5 + 3) + "," + px(i * 5 + 4) + " " + px(i * 5 + 5) + "," + px(i * 5 + 6, 110) + " " +
            px(i * 5 + 7) + '" fill="none" stroke="' + ink + '" stroke-width="' + (3 + i * 2) +
            '" stroke-linecap="round" opacity=".65"/>'
        )
        .join("") +
      '<rect x="' + (72 + px(3, 8)) + '" y="' + (66 + px(4, 10)) +
      '" width="14" height="14" rx="2" fill="' + accent + '" opacity=".86"/>';
  } else if (variant === "cutpaper") {
    art =
      [0, 1, 2, 3]
        .map(
          (i) =>
            '<path d="M' + px(i * 3) + " " + px(i * 3 + 1) + " L" + px(i * 3 + 2) + " " +
            px(i * 3 + 3) + " L" + px(i * 3 + 4) + " " + px(i * 3 + 5) + ' Z" fill="' +
            (i % 2 ? accent : ink) + '" opacity=".7"/>'
        )
        .join("") +
      '<circle cx="' + px(20) + '" cy="' + px(21) + '" r="' + (8 + px(22, 8)) +
      '" fill="' + accent + '" opacity=".55"/>';
  } else if (variant === "chalk") {
    art =
      Array.from(
        { length: 7 },
        (_, i) => curve(i * 2, ink, 1 + px(i, 2), 0.4, px(i, 8) + 4 + " " + (px(i + 1, 6) + 3))
      ).join("") +
      [0, 1, 2, 3, 4]
        .map((i) => '<circle cx="' + px(i * 7 + 50) + '" cy="' + px(i * 7 + 51) + '" r=".9" fill="' + ink + '" opacity=".45"/>')
        .join("");
  } else if (variant === "blueprint") {
    art =
      '<g stroke="' + accent + '" stroke-width=".5" opacity=".45">' +
      Array.from({ length: 9 }, (_, i) => '<path d="M0 ' + i * 12 + ' H100"/>').join("") +
      Array.from({ length: 9 }, (_, i) => '<path d="M' + i * 12 + ' 0 V100"/>').join("") +
      "</g>" +
      '<circle cx="70" cy="32" r="15" fill="none" stroke="' + accent + '" stroke-width="1.2" opacity=".8"/>' +
      '<path d="M55 32 H85 M70 17 V47" stroke="' + accent + '" stroke-width=".8" opacity=".6"/>';
  } else if (variant === "engrave") {
    art =
      Array.from(
        { length: 14 },
        (_, i) =>
          '<path d="M0 ' + (i * 7 + 4) + " Q50 " + (i * 7 + px(i, 9) - 4) + " 100 " + (i * 7 + 4) +
          '" fill="none" stroke="' + ink + '" stroke-width=".5" opacity=".28"/>'
      ).join("") +
      '<circle cx="70" cy="70" r="14" fill="none" stroke="' + accent + '" stroke-width=".8" opacity=".5"/>';
  } else if (variant === "marker") {
    art =
      [0, 1, 2]
        .map(
          (i) =>
            '<path d="M' + (px(i * 4) - 8) + " " + px(i * 4 + 1) + " L" + px(i * 4 + 2, 110) + " " +
            px(i * 4 + 3) + '" stroke="' + (i === 0 ? accent : ink) + '" stroke-width="' +
            (5 + i * 2) + '" stroke-linecap="square" opacity=".28"/>'
        )
        .join("") +
      curve(30, accent, 2, 0.5);
  } else if (variant === "flat") {
    art =
      '<circle cx="76" cy="24" r="18" fill="' + accent + '" opacity=".5"/>' +
      '<rect x="60" y="58" width="30" height="30" rx="6" fill="' + ink + '" opacity=".25"/>' +
      '<path d="M0 86 L34 58 L58 86 Z" fill="' + accent + '" opacity=".35"/>';
  } else if (variant === "spark") {
    art = Array.from(
      { length: 9 },
      (_, i) =>
        '<path d="M' + px(i * 3) + " " + px(i * 3 + 1) +
        ' l2 6 l6 2 l-6 2 l-2 6 l-2 -6 l-6 -2 l6 -2 z" fill="' + accent +
        '" opacity="' + (0.25 + px(i, 50) / 100) + '"/>'
    ).join("");
  } else if (variant === "chart") {
    art = [0, 1, 2, 3]
      .map(
        (i) =>
          '<rect x="' + (10 + i * 21) + '" y="' + (76 - i * 14) + '" width="13" height="' +
          (16 + i * 14) + '" rx="3" fill="' + (i === 3 ? accent : ink) + '" opacity="' +
          (i === 3 ? 0.85 : 0.16) + '"/>'
      )
      .join("");
  } else {
    art =
      '<g fill="' + ink + '" opacity=".13">' +
      Array.from({ length: 24 }, (_, i) => '<circle cx="' + px(i * 2) + '" cy="' + px(i * 2 + 1) + '" r=".9"/>').join("") +
      "</g>";
  }
  return '<svg viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' + art + "</svg>";
}

/* 手绘风格插画层：按出图引擎（render/sketch.ts）的构图特征重绘，
   画在标题面板上方，缩略图与画布都与真实出图保持同一套视觉语言。 */
function tedSketchArtSvg(variant, colors, seedInput) {
  const ink = colors[1];
  const accent = colors[2];
  const seed = String(seedInput || "art")
    .split("")
    .reduce((sum, ch) => sum + ch.charCodeAt(0), 7);
  const px = (i, mod = 100) => {
    const v = Math.sin(seed * 7.13 + i * 11.71) * 43758.5453;
    return Math.round((((v % 1) + 1) % 1) * mod);
  };
  const p = [];
  if (variant === "cutpaper") {
    p.push(`<path d="M0 40 L9 30 L18 40 L27 28 L38 40 L49 26 L60 40 L71 29 L82 40 L93 31 L104 40 L108 36 V83 H0 Z" fill="${accent}" opacity=".5"/>`);
    p.push(`<path d="M0 56 L12 44 L24 56 L36 42 L50 56 L62 43 L74 56 L86 45 L98 56 L108 48 V83 H0 Z" fill="${accent}" opacity=".85"/>`);
    p.push(`<path d="M0 71 L14 59 L28 71 L42 57 L56 71 L70 59 L84 71 L98 61 L108 69 V83 H0 Z" fill="${ink}" opacity=".92"/>`);
    p.push(`<circle cx="24" cy="17" r="8.5" fill="${accent}" opacity=".96"/><circle cx="24" cy="17" r="6" fill="none" stroke="${ink}" stroke-width=".4" opacity=".42"/><circle cx="24" cy="17" r="3.4" fill="none" stroke="${ink}" stroke-width=".32" opacity=".32"/>`);
    p.push(`<path d="M64 6 v4" stroke="${ink}" stroke-width=".5"/><rect x="62.9" y="5" width="2.2" height="1.1" fill="${ink}"/><ellipse cx="64" cy="15" rx="2.9" ry="3.9" fill="${ink}"/><path d="M64 19 v4" stroke="${ink}" stroke-width=".5"/><rect x="62.9" y="19.4" width="2.2" height="1" fill="${ink}"/>`);
    p.push(`<path d="M0 4.5 H108" stroke="${ink}" stroke-width=".45"/>`);
    for (let i = 0; i < 11; i++) {
      const x = 4 + i * 10;
      p.push(`<path d="M${x} 4.5 l2.2 4.4 l2.2 -4.4 Z" fill="${i % 2 ? ink : accent}"/>`);
    }
    for (let i = 0; i < 7; i++) {
      p.push(`<circle cx="${px(i * 3, 104) + 3}" cy="${px(i * 3 + 1, 70) + 8}" r="${5 + px(i + 2, 5)}" fill="${i % 2 ? accent : ink}" opacity=".5"/>`);
    }
  } else if (variant === "sumie") {
    p.push(`<ellipse cx="${34 + px(1, 20)}" cy="${44 + px(2, 20)}" rx="${30 + px(3, 12)}" ry="${18 + px(4, 8)}" fill="${ink}" opacity=".08"/>`);
    [0, 1, 2].forEach((i) => {
      p.push(`<path d="M${4 + i * 5} ${30 + i * 12} C${26 + i * 9} ${6 + i * 7},${62 + i * 5} ${58 - i * 6},${104 - i * 9} ${26 + i * 12}" fill="none" stroke="${ink}" stroke-width="${3 + i * 2.6}" stroke-linecap="round" opacity="${0.62 - i * 0.12}"/>`);
    });
    p.push(`<rect x="88" y="58" width="11" height="11" rx="1.5" fill="${accent}" opacity=".9"/>`);
    p.push(`<path d="M12 70 Q34 62 56 70" fill="none" stroke="${ink}" stroke-width=".7" opacity=".35"/>`);
  } else if (variant === "pencil") {
    for (let i = 0; i < 12; i++) {
      p.push(`<path d="M${px(i, 40)} ${px(i + 1, 80)} L${px(i + 2, 100) + 8} ${px(i + 3, 80)}" stroke="${ink}" stroke-width="${0.35 + px(i, 4) / 10}" stroke-linecap="round" opacity="${0.12 + px(i + 4, 22) / 100}"/>`);
    }
    p.push(`<ellipse cx="34" cy="48" rx="20" ry="13" fill="${accent}" opacity=".28"/>`);
    p.push(`<ellipse cx="76" cy="34" rx="15" ry="10" fill="${accent}" opacity=".2"/>`);
    p.push(`<path d="M14 66 Q30 56 46 66 T78 64" fill="none" stroke="${ink}" stroke-width=".8" opacity=".4"/>`);
  } else if (variant === "marker") {
    p.push(`<path d="M6 52 L34 22 L62 52 L90 20" fill="none" stroke="${ink}" stroke-width="4.2" stroke-linecap="square" opacity=".85"/>`);
    p.push(`<path d="M14 62 L44 36 L74 62 L102 34" fill="none" stroke="${accent}" stroke-width="3.2" stroke-linecap="square" opacity=".9"/>`);
    for (let i = 0; i < 6; i++) {
      p.push(`<circle cx="${72 + (i % 3) * 6}" cy="${58 + Math.floor(i / 3) * 7}" r="1.6" fill="${ink}" opacity=".55"/>`);
    }
    for (let i = 0; i < 5; i++) {
      p.push(`<path d="M${90 + i * 3} ${8 + i * 3} l${6 + i} ${6 + i}" stroke="${ink}" stroke-width="1" opacity=".5"/>`);
    }
  } else if (variant === "flat") {
    p.push(`<circle cx="26" cy="26" r="13" fill="${accent}" opacity=".85"/>`);
    p.push(`<rect x="58" y="14" width="30" height="22" rx="4" fill="${ink}" opacity=".82"/>`);
    p.push(`<path d="M0 78 L28 44 L56 78 Z" fill="${accent}" opacity=".75"/>`);
    p.push(`<rect x="66" y="46" width="24" height="24" rx="12" fill="${ink}" opacity=".4"/>`);
  } else if (variant === "chalk") {
    for (let i = 0; i < 6; i++) {
      p.push(`<path d="M${px(i * 2, 94)} ${px(i * 2 + 1, 70) + 6} L${px(i * 2 + 2, 100)} ${px(i * 2 + 3, 70) + 6}" stroke="${ink}" stroke-width="${1 + px(i, 2)}" stroke-linecap="round" stroke-dasharray="${3 + px(i, 6)} ${2 + px(i + 1, 5)}" opacity=".42"/>`);
    }
    p.push(`<circle cx="30" cy="30" r="12" fill="none" stroke="${accent}" stroke-width="1.1" stroke-dasharray="4 3" opacity=".75"/>`);
    for (let i = 0; i < 10; i++) {
      p.push(`<circle cx="${px(i * 3, 104) + 2}" cy="${px(i * 3 + 1, 74) + 5}" r=".6" fill="${ink}" opacity=".4"/>`);
    }
  } else if (variant === "blueprint") {
    for (let i = 0; i < 13; i++) {
      p.push(`<path d="M0 ${i * 7} H108" stroke="${accent}" stroke-width=".28" opacity=".45"/>`);
      p.push(`<path d="M${i * 9} 0 V83" stroke="${accent}" stroke-width=".28" opacity=".45"/>`);
    }
    p.push(`<circle cx="74" cy="28" r="17" fill="none" stroke="${accent}" stroke-width="1" opacity=".85"/>`);
    p.push(`<path d="M57 28 H91 M74 11 V45" stroke="${accent}" stroke-width=".7" opacity=".7"/>`);
    p.push(`<path d="M18 60 H46 M18 57 v6 M46 57 v6" stroke="${accent}" stroke-width=".7" opacity=".8"/>`);
  } else if (variant === "engrave") {
    for (let i = 0; i < 18; i++) {
      p.push(`<path d="M0 ${4 + i * 4.4} Q54 ${i * 4.4 + px(i, 7)} 108 ${4 + i * 4.4}" fill="none" stroke="${ink}" stroke-width=".35" opacity=".32"/>`);
    }
    p.push(`<ellipse cx="76" cy="26" rx="15" ry="12" fill="none" stroke="${accent}" stroke-width=".7" opacity=".7"/>`);
    p.push(`<circle cx="76" cy="26" r="7" fill="none" stroke="${ink}" stroke-width=".4" opacity=".45"/>`);
  } else if (variant === "watercolor") {
    const id = "wc" + seed;
    p.push(`<defs><filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter></defs>`);
    [0, 1, 2, 3, 4].forEach((i) => {
      p.push(`<ellipse cx="${px(i * 4, 96) + 6}" cy="${px(i * 4 + 1, 64) + 8}" rx="${10 + px(i, 12)}" ry="${7 + px(i + 1, 9)}" fill="${i % 2 ? accent : ink}" opacity="${0.14 + px(i + 2, 14) / 100}" filter="url(#${id})"/>`);
    });
    p.push(`<path d="M12 68 Q34 54 58 66" fill="none" stroke="${ink}" stroke-width=".7" opacity=".35"/>`);
  } else {
    for (let i = 0; i < 12; i++) {
      p.push(`<circle cx="${px(i * 2, 104) + 2}" cy="${px(i * 2 + 1, 76) + 4}" r=".8" fill="${ink}" opacity=".16"/>`);
    }
  }
  return `<svg viewBox="0 0 108 83" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${p.join("")}</svg>`;
}
const TED_SKETCH_DECOS = new Set(["cutpaper", "sumie", "pencil", "marker", "flat", "chalk", "blueprint", "engrave", "watercolor"]);

/* 按风格与版式程序化生成某页型的示例元素（结构与渲染 schema 一致） */
function tedOfficialElements(style, pageType) {
  const [bg, ink, accent] = style.colors;
  const layout = style.layout || "standard";
  let id = 0;
  const nid = () => `${style.key}-${pageType}-${id++}`;
  const text = (x, y, w, h, content, fontSize, fontWeight, color, extra = {}) =>
    ({ id: nid(), type: "text", x, y, w, h, rotate: 0, z: 0, style: { content, fontSize, fontWeight, color, align: "left", lineHeight: 1.4, letterSpacing: 0, bg: "transparent", radius: 0, ...extra } });
  const box = (x, y, w, h, fill, radius = 0, type = "shape", extra = {}) =>
    ({ id: nid(), type, x, y, w, h, rotate: 0, z: 0, style: { bg: fill, radius, ...extra } });
  const img = (x, y, w, h, src) =>
    ({ id: nid(), type: "image", x, y, w, h, rotate: 0, z: 0, style: { src, radius: 0 } });
  const badge = (x, y, size, content) =>
    ({ id: nid(), type: "badge", x, y, w: size, h: size, rotate: 0, z: 0, style: { content, fontSize: Math.round(size * 0.4), fontWeight: "800", color: "#ffffff", bg: accent, radius: Math.round(size * 0.22) } });
  const chip = (x, y, w, content) =>
    ({ id: nid(), type: "chip", x, y, w, h: 62, rotate: 0, z: 0, style: { content, fontSize: 26, fontWeight: "700", color: accent, bg: "transparent", radius: 999 } });
  const divider = (x, y, w) =>
    ({ id: nid(), type: "shape", x, y, w, h: 5, rotate: 0, z: 0, style: { bg: ink, radius: 3, opacity: 22 } });
  const dots = (x, y, w, h) =>
    ({ id: nid(), type: "dots", x, y, w, h, rotate: 0, z: 0, style: { color: accent, opacity: 45 } });
  const deco = (x, y, w, h, variant = style.deco || "paper", opacity = 100) =>
    ({ id: nid(), type: "deco", x, y, w, h, rotate: 0, z: 0, style: { variant, colors: style.colors, opacity } });
  const els = [];
  if (pageType === "cover") {
    els.push(box(0, 0, 1080, 1440, bg));
    els.push(deco(0, 0, 1080, 1440));
    if (layout === "poster") {
      els.push(text(90, 280, 900, 420, "{标题}", 132, "800", accent, { lineHeight: 1.08 }));
      els.push(box(90, 760, 240, 10, accent, 5));
      els.push(text(90, 810, 880, 200, "{正文摘要}", 44, "400", "#c9cfda", { lineHeight: 1.6 }));
      els.push(chip(90, 1180, 250, "大字公告"));
      els.push(text(760, 1330, 240, 50, "{日期}", 30, "400", "#9aa2b1", { align: "right" }));
    } else if (layout === "chart") {
      els.push(text(72, 250, 700, 260, "{标题}", 96, "800", ink));
      els.push(text(72, 540, 620, 120, "{正文摘要}", 40, "400", "#5b6570", { lineHeight: 1.6 }));
      els.push(text(72, 760, 520, 200, "78%", 160, "800", accent));
      els.push(text(72, 980, 600, 70, "关键指标同比提升", 38, "400", "#5b6570"));
      els.push(box(72, 1120, 130, 170, ink, 10));
      els.push(box(222, 1170, 130, 120, ink, 10));
      els.push(box(372, 1230, 130, 60, ink, 10));
      els.push(box(522, 1080, 130, 210, accent, 10));
      els.push(text(72, 1330, 600, 50, "{日期}", 30, "400", "#8b949e"));
    } else if (layout === "versus") {
      els.push(text(72, 230, 936, 200, "{标题}", 88, "800", ink));
      els.push(box(72, 520, 440, 620, accent, 24, "shape", { opacity: 92 }));
      els.push(box(568, 520, 440, 620, ink, 24, "shape", { opacity: 88 }));
      els.push(text(112, 580, 360, 100, "方案 A", 60, "800", "#ffffff"));
      els.push(text(608, 580, 360, 100, "方案 B", 60, "800", bg));
      els.push(chip(72, 1220, 230, "实测对比"));
      els.push(text(72, 1330, 600, 50, "{日期}", 30, "400", "#8b949e"));
    } else if (layout === "caption") {
      els.push(text(72, 170, 936, 160, "{标题}", 76, "800", ink));
      els.push(box(72, 380, 936, 760, accent, 24, "image"));
      els.push(text(72, 1190, 936, 150, "{正文摘要}", 40, "400", "#5b6570", { lineHeight: 1.6 }));
      els.push(text(72, 1360, 300, 50, "{日期}", 28, "400", "#8b949e"));
    } else if (layout === "illust") {
      // 与真实手绘封面一致：真实插画底图 + 纸色文字面板（间距/字号对齐 sketch 引擎）
      els.push(img(0, 0, 1080, 1440, `/designs/samples/${style.key}-cover-art.png`));
      els.push(box(84, 779, 912, 580, bg, 26));
      els.push(text(138, 827, 804, 34, `ECHOQ · ${String(style.en || "").toUpperCase()}`, 24, "700", accent, { letterSpacing: 6 }));
      els.push(box(138, 875, 804, 3, ink, 2, "shape", { opacity: 14 }));
      els.push(text(138, 903, 804, 240, "{标题}", 92, "800", ink, { lineHeight: 1.24 }));
      els.push(text(138, 1157, 804, 122, "{正文摘要}", 38, "400", ink, { lineHeight: 1.6, opacity: 74 }));
      els.push(text(138, 1289, 804, 24, `${style.name} / 手绘插画`, 18, "400", ink, { opacity: 60 }));
    } else {
      // 与真实「知识卡片 / 步骤清单」封面一致：顶部品牌行 + 大标题 + 摘要 + 目录 + 页脚
      els.push(text(72, 84, 740, 44, `ECHOQ · ${String(style.en || "").toUpperCase()}`, 26, "700", accent, { letterSpacing: 5 }));
      els.push(box(72, 158, 150, 10, accent, 5));
      els.push(text(72, 236, 936, 300, "{标题}", 96, "800", ink, { lineHeight: 1.2 }));
      els.push(text(72, 560, 900, 130, "{正文摘要}", 42, "400", "#5b6570", { lineHeight: 1.6 }));
      ["大标题只说一件事", "每页最多三个要点", "留白也是信息", "结尾"].forEach((item, i) => {
        els.push(text(72, 900 + i * 62, 80, 46, `P0${i + 2}`, 28, "700", accent, { letterSpacing: 2 }));
        els.push(text(158, 900 + i * 62, 800, 46, item, 30, "400", ink));
      });
      els.push(text(72, 1330, 640, 50, `${style.name} / 实用信息流`, 26, "400", "#8b949e", { letterSpacing: 1 }));
      els.push(text(828, 1330, 180, 50, "P01 · 06", 26, "400", "#8b949e", { align: "right" }));
    }
  } else if (pageType === "content") {
    els.push(box(0, 0, 1080, 1440, bg));
    els.push(deco(0, 0, 1080, 1440, style.deco, layout === "illust" ? 70 : 100));
    if (layout === "chart") {
      els.push(text(72, 160, 936, 130, "{标题} · 数据拆解", 60, "800", ink));
      els.push(divider(72, 330, 936));
      [0, 1, 2].forEach((i) => {
        els.push(text(72, 400 + i * 240, 340, 80, ["新增用户", "完播率", "转化率"][i], 40, "600", ink));
        els.push(box(440, 420 + i * 240, 480, 52, "#E7ECF3", 26));
        els.push(box(440, 420 + i * 240, 480 * [0.72, 0.46, 0.31][i], 52, accent, 26));
        els.push(text(940, 400 + i * 240, 80, 80, ["72%", "46%", "31%"][i], 38, "800", accent, { align: "right" }));
      });
      els.push(text(72, 1200, 936, 120, "结论：先看结构，再看单点差异。", 42, "600", ink));
    } else if (layout === "versus") {
      els.push(text(72, 160, 936, 130, "{标题} · 对比", 60, "800", ink));
      els.push(divider(72, 330, 936));
      els.push(box(72, 400, 440, 720, accent, 20, "shape", { opacity: 90 }));
      els.push(box(568, 400, 440, 720, ink, 20, "shape", { opacity: 86 }));
      els.push(text(112, 450, 360, 80, "优点", 46, "800", "#ffffff"));
      els.push(text(608, 450, 360, 80, "缺点", 46, "800", bg));
      els.push(text(112, 560, 360, 480, "· 上手快\n· 成本低\n· 适合新手", 34, "400", "#ffffff", { lineHeight: 1.9 }));
      els.push(text(608, 560, 360, 480, "· 深度不足\n· 后期受限\n· 需要补课", 34, "400", bg, { lineHeight: 1.9 }));
      els.push(text(72, 1200, 936, 120, "结论：按阶段选，不按喜好选。", 42, "600", ink));
    } else if (layout === "illust") {
      // 真实内容页：插画底图 + 纸色面板（品牌行 / 段落标题 / 三条编号要点 / 页脚）
      els.push(img(0, 0, 1080, 1440, `/designs/samples/${style.key}-content-art.png`));
      els.push(box(84, 559, 912, 800, bg, 26));
      els.push(text(138, 607, 804, 32, `ECHOQ · ${String(style.en || "").toUpperCase()}`, 24, "700", accent, { letterSpacing: 6 }));
      els.push(box(138, 655, 804, 3, ink, 2, "shape", { opacity: 14 }));
      els.push(text(138, 683, 804, 100, "{标题}", 52, "800", ink, { lineHeight: 1.3 }));
      ["一眼就知道这篇讲什么", "超过三个就拆页", "密的地方读者会跳过"].forEach((item, i) => {
        els.push(badge(138, 838 + i * 150, 64, `0${i + 1}`));
        els.push(text(224, 820 + i * 150, 718, 140, item, 38, "600", ink, { lineHeight: 1.5 }));
      });
      els.push(text(138, 1289, 804, 24, `${style.name} / 手绘插画`, 18, "400", ink, { opacity: 60 }));
    } else {
      // 与真实内容页一致：品牌行 + 标题 + 分隔线 + 编号要点 + 页脚
      els.push(text(72, 84, 740, 40, `ECHOQ · ${String(style.en || "").toUpperCase()}`, 24, "700", accent, { letterSpacing: 5 }));
      els.push(box(72, 152, 130, 10, accent, 5));
      els.push(text(72, 216, 936, 120, "{标题}", 66, "800", ink));
      els.push(divider(72, 360, 936));
      ["一眼就知道这篇讲什么", "超过三个就拆页", "密的地方读者会跳过"].forEach((item, i) => {
        els.push(badge(72, 424 + i * 210, 84, `0${i + 1}`));
        els.push(text(196, 416 + i * 210, 812, 140, item, 40, "400", ink, { lineHeight: 1.7 }));
      });
      els.push(text(72, 1330, 640, 46, `${style.name} / 实用信息流`, 24, "400", "#8b949e"));
      els.push(text(828, 1330, 180, 46, "P02 · 06", 24, "400", "#8b949e", { align: "right" }));
    }
  } else if (layout === "illust") {
    els.push(img(0, 0, 1080, 1440, `/designs/samples/${style.key}-ending-art.png`));
    els.push(box(84, 739, 912, 620, bg, 26));
    els.push(text(138, 787, 804, 32, `ECHOQ · ${String(style.en || "").toUpperCase()}`, 24, "700", accent, { letterSpacing: 6 }));
    els.push(box(138, 835, 804, 3, ink, 2, "shape", { opacity: 14 }));
    els.push(text(138, 864, 804, 280, "{结尾金句}", 64, "800", ink, { lineHeight: 1.4 }));
    els.push(text(138, 1160, 804, 120, "先存着，用得上时翻出来", 36, "400", ink, { lineHeight: 1.6, opacity: 74 }));
    els.push(text(138, 1289, 804, 24, `${style.name} / 手绘插画`, 18, "400", ink, { opacity: 60 }));
  } else if (layout === "poster") {
    els.push(box(0, 0, 1080, 1440, bg));
    els.push(deco(0, 0, 1080, 1440, style.deco, 90));
    els.push(dots(72, 100, 172, 104));
    els.push(text(140, 400, 800, 300, "{结尾金句}", 84, "800", ink, { align: "center", lineHeight: 1.35 }));
    els.push(box(440, 760, 200, 8, accent, 4));
    els.push(text(240, 830, 600, 80, "扫码看完整内容", 40, "400", ink, { align: "center" }));
    els.push(box(440, 950, 200, 200, "#ffffff", 14, "qrcode"));
    els.push(chip(430, 1210, 220, "关注不迷路"));
    els.push(dots(836, 1230, 172, 104));
  } else {
    // 与真实末页一致：浅色背景 + 品牌行 + 结尾金句 + 延伸提示 + 页脚
    els.push(box(0, 0, 1080, 1440, bg));
    els.push(deco(0, 0, 1080, 1440, style.deco, 45));
    els.push(text(72, 84, 740, 40, `ECHOQ · ${String(style.en || "").toUpperCase()}`, 24, "700", accent, { letterSpacing: 5 }));
    els.push(box(72, 152, 130, 10, accent, 5));
    els.push(text(72, 300, 900, 360, "{结尾金句}", 76, "800", ink, { lineHeight: 1.38 }));
    els.push(text(72, 740, 880, 120, "先存着，用得上时翻出来", 38, "400", "#5b6570", { lineHeight: 1.7 }));
    els.push(divider(72, 1060, 936));
    els.push(text(72, 1120, 880, 90, "你最想先试哪一个？", 40, "600", ink));
    els.push(text(72, 1330, 640, 46, `${style.name} / 实用信息流`, 24, "400", "#8b949e"));
    els.push(text(828, 1330, 180, 46, "P06 · 06", 24, "400", "#8b949e", { align: "right" }));
  }
  els.forEach((el, i) => { el.z = i + 1; });
  return els;
}

/* ---------------- 基础工具 ---------------- */
function tedCurPage() { return tedState.pages[tedState.currentPage]; }
function tedCurElements() { return tedState.browse ? tedOfficialElements(tedState.browse.tpl, tedState.browse.page) : tedCurPage().elements; }
function tedInBrowse() { return Boolean(tedState.browse); }

let tedUid = 1;
const tedNewId = (prefix) => `${prefix}-${tedUid++}-${Date.now().toString(36).slice(-4)}`;

function tedToast(msg) {
  const t = document.querySelector("#view-templates .toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 1800);
}
const tedClamp = (v, min, max) => Math.min(max, Math.max(min, v));
function tedSnapshot() { return JSON.stringify({ pages: tedState.pages }); }
function tedPushHistory() {
  tedState.history.push(tedSnapshot());
  if (tedState.history.length > 60) tedState.history.shift();
  tedState.future = [];
  tedRefreshHistoryButtons();
}
function tedRestore(json) {
  tedState.pages = JSON.parse(json).pages;
  if (!tedCurElements().some((el) => el.id === tedState.selectedId)) tedState.selectedId = null;
  tedApplyCanvasSize(false);
  tedRenderAll();
}
function tedUndo() { if (!tedState.history.length) return; tedState.future.push(tedSnapshot()); tedRestore(tedState.history.pop()); tedRefreshHistoryButtons(); }
function tedRedo() { if (!tedState.future.length) return; tedState.history.push(tedSnapshot()); tedRestore(tedState.future.pop()); tedRefreshHistoryButtons(); }
function tedRefreshHistoryButtons() {
  const undoBtn = document.getElementById("ted-undo");
  const redoBtn = document.getElementById("ted-redo");
  if (undoBtn) undoBtn.disabled = !tedState.history.length;
  if (redoBtn) redoBtn.disabled = !tedState.future.length;
}

/* ---------------- 元素工厂 ---------------- */
const TED_FACTORY = {
  title: () => ({ type: "text", w: 800, h: 220, style: { content: "点击编辑标题", fontSize: 96, fontWeight: "800", color: "#1f2328", align: "left", lineHeight: 1.25, letterSpacing: 0, bg: "transparent", radius: 0 } }),
  text: () => ({ type: "text", w: 560, h: 160, style: { content: "双击编辑这段文字", fontSize: 40, fontWeight: "400", color: "#3a4148", align: "left", lineHeight: 1.6, letterSpacing: 0, bg: "transparent", radius: 0 } }),
  image: () => ({ type: "image", w: 480, h: 360, style: { radius: 16, bg: "#f3f1ec" } }),
  shape: () => ({ type: "shape", w: 320, h: 160, style: { bg: "#e8503a", radius: 12 } }),
  circle: () => ({ type: "shape", w: 200, h: 200, style: { bg: "#ffd9d2", radius: 999 } }),
  qrcode: () => ({ type: "qrcode", w: 180, h: 180, style: { radius: 10 } }),
  badge: () => ({ type: "badge", w: 96, h: 96, style: { content: "01", fontSize: 40, fontWeight: "800", color: "#ffffff", bg: "#e8503a", radius: 18 } }),
  chip: () => ({ type: "chip", w: 220, h: 64, style: { content: "标签文字", fontSize: 28, fontWeight: "700", color: "#e8503a", bg: "transparent", radius: 999 } }),
  divider: () => ({ type: "shape", w: 600, h: 6, style: { bg: "#1f2328", radius: 3, opacity: 30 } }),
  dots: () => ({ type: "dots", w: 180, h: 110, style: { color: "#e8503a", opacity: 55 } }),
};
function tedAddElement(kind, x, y) {
  if (tedInBrowse()) { tedToast("正在浏览官方模板，点「返回编辑」后再添加"); return; }
  const fn = TED_FACTORY[kind];
  if (!fn) return;
  const base = fn();
  const page = tedCurPage();
  const el = {
    id: tedNewId(kind), type: base.type,
    x: Math.round(x ?? (page.canvas.w - base.w) / 2),
    y: Math.round(y ?? (page.canvas.h - base.h) / 2),
    w: base.w, h: base.h, rotate: 0,
    z: page.elements.length + 1, style: base.style,
  };
  tedPushHistory();
  page.elements.push(el);
  tedState.selectedId = el.id;
  tedRenderAll();
}

/* ---------------- 渲染 ---------------- */
function tedElStyleCss(el) {
  const s = el.style || {};
  const grad = s.gradTo ? `linear-gradient(${s.gradAngle || 90}deg, ${s.bg || "#e8503a"}, ${s.gradTo})` : "";
  const css = {
    left: el.x + "px", top: el.y + "px", width: el.w + "px", height: el.h + "px",
    transform: el.rotate ? `rotate(${el.rotate}deg)` : "",
    zIndex: el.z || 1, opacity: (s.opacity ?? 100) / 100,
  };
  if (el.type === "text") {
    css.fontSize = (s.fontSize || 40) + "px";
    css.fontWeight = s.fontWeight || 400;
    css.color = s.color || "#1f2328";
    css.textAlign = s.align || "left";
    css.lineHeight = s.lineHeight || 1.5;
    css.letterSpacing = (s.letterSpacing || 0) + "px";
    css.background = s.bg && s.bg !== "transparent" ? (grad || s.bg) : "transparent";
    css.borderRadius = (s.radius || 0) + "px";
    css.display = "flex";
    css.alignItems = "flex-start";
  } else if (el.type === "image") {
    css.background = grad || `linear-gradient(135deg, ${s.bg || "#f3f1ec"}, #e6e1d8)`;
    css.borderRadius = (s.radius || 0) + "px";
  } else if (el.type === "shape") {
    css.background = grad || s.bg || "#e8503a";
    css.borderRadius = (s.radius || 0) + "px";
  } else if (el.type === "badge") {
    css.background = grad || s.bg || "#e8503a";
    css.borderRadius = (s.radius || 18) + "px";
    css.color = s.color || "#ffffff";
    css.fontSize = (s.fontSize || 40) + "px";
    css.fontWeight = s.fontWeight || 800;
  } else if (el.type === "chip") {
    css.border = `3px solid ${s.color || "#e8503a"}`;
    css.borderRadius = (s.radius || 999) + "px";
    css.color = s.color || "#e8503a";
    css.fontSize = (s.fontSize || 28) + "px";
    css.fontWeight = s.fontWeight || 700;
    css.background = s.bg && s.bg !== "transparent" ? (grad || s.bg) : "transparent";
  } else if (el.type === "dots") {
    css.color = s.color || "#e8503a";
    css.opacity = (s.opacity ?? 55) / 100;
  } else if (el.type === "qrcode") {
    css.borderRadius = (s.radius || 0) + "px";
  } else if (el.type === "deco") {
    css.pointerEvents = "none";
  }
  return css;
}
const TED_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w", "rot"];
function tedCreateElNode(el, interactive) {
  const node = document.createElement("div");
  node.className = `el ${el.type}`;
  node.dataset.id = el.id;
  Object.assign(node.style, tedElStyleCss(el));
  if (el.type === "text" || el.type === "badge" || el.type === "chip") {
    node.textContent = el.style.content || "";
    if (interactive && tedState.editingId === el.id) {
      node.classList.add("editing");
      node.contentEditable = "true";
      node.spellcheck = false;
    }
  } else if (el.type === "image") {
    if (el.style.src) {
      const img = document.createElement("img");
      img.src = el.style.src;
      node.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "ph-icon";
      icon.textContent = "🖼";
      node.appendChild(icon);
    }
  } else if (el.type === "dots") {
    for (let i = 0; i < 8; i++) node.appendChild(document.createElement("i"));
  } else if (el.type === "qrcode") {
    for (let i = 0; i < 25; i++) {
      const cell = document.createElement("i");
      if ([0,1,2,3,4,5,9,10,14,15,16,17,18,19,20,21,23,24,7,13,11].includes(i)) cell.className = "off";
      node.appendChild(cell);
    }
  } else if (el.type === "deco") {
    node.innerHTML = TED_SKETCH_DECOS.has(el.style.variant)
      ? tedSketchArtSvg(el.style.variant, el.style.colors || ["#ffffff", "#333333", "#e8503a"], el.id)
      : tedDecoSvg(el.style.variant || "paper", el.style.colors || ["#ffffff", "#333333", "#e8503a"], el.id);
  }
  if (interactive && el.id === tedState.selectedId && tedState.editingId !== el.id) {
    TED_HANDLES.forEach((h) => {
      const dot = document.createElement("div");
      dot.className = "handle " + h;
      dot.dataset.handle = h;
      node.appendChild(dot);
    });
  }
  return node;
}
function tedRenderCanvas() {
  const canvas = document.getElementById("ted-canvas");
  canvas.querySelectorAll(".el").forEach((n) => n.remove());
  canvas.classList.toggle("browsing", tedInBrowse());
  tedCurElements()
    .slice()
    .sort((a, b) => (a.z || 0) - (b.z || 0))
    .forEach((el) => {
      const node = tedCreateElNode(el, !tedInBrowse());
      if (tedState.multiSel.has(el.id) || tedState.selectedId === el.id) node.classList.add("selected");
      canvas.appendChild(node);
    });
  const bar = document.getElementById("ted-browse-bar");
  const stage = document.getElementById("ted-stage");
  const browsing = tedInBrowse();
  if (stage) stage.classList.toggle("has-browse", browsing);
  const sample = document.getElementById("ted-sample");
  const canvasEl = document.getElementById("ted-canvas");
  if (browsing) {
    bar.hidden = false;
    bar.querySelector(".bb-name").textContent = `官方模板 · ${tedState.browse.tpl.name} · ${TED_PAGE_TYPES.find((p) => p.key === tedState.browse.page).name}`;
    if (sample) {
      sample.src = tedSampleUrl(tedState.browse.tpl, tedState.browse.page);
      sample.hidden = false;
    }
    if (canvasEl) canvasEl.style.visibility = "hidden";
  } else {
    bar.hidden = true;
    if (sample) sample.hidden = true;
    if (canvasEl) canvasEl.style.visibility = "";
  }
}
function tedFitCanvas() {
  const { w, h } = tedCurPage().canvas;
  const stage = document.getElementById("ted-stage");
  const frame = document.getElementById("ted-canvas-frame");
  const cs = getComputedStyle(stage);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const availW = stage.clientWidth - padX - 12;
  const availH = stage.clientHeight - padY - 12;
  let scale = Math.min(availW > 60 ? availW / w : 1, availH > 60 ? availH / h : 1, 1);
  if (!Number.isFinite(scale) || scale <= 0) scale = 0.32;
  scale = Math.max(scale, 0.2);
  tedState.scale = scale;
  frame.style.width = w * scale + "px";
  frame.style.height = h * scale + "px";
  const canvas = document.getElementById("ted-canvas");
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.style.transform = `scale(${scale})`;
}
function tedApplyCanvasSize(record = true) {
  tedFitCanvas();
  if (record) tedPushHistory();
}
function tedRenderProps() {
  const el = tedCurElements().find((e) => e.id === tedState.selectedId);
  const empty = document.getElementById("ted-props-empty");
  const props = document.getElementById("ted-props");
  if (tedInBrowse()) {
    props.hidden = true;
    empty.hidden = false;
    empty.innerHTML = "浏览官方模板中。<br />选元素按 <b>Ctrl+C</b> 复制；<br />双击页型或点上方「用此页开始编辑」，<br />即可把它变成你自己的可编辑模板。";
    return;
  }
  empty.innerHTML = "未选中元素。<br />点击画布中的元素进行编辑。";
  empty.hidden = Boolean(el);
  props.hidden = !el;
  if (!el) return;
  document.getElementById("ted-p-x").value = el.x;
  document.getElementById("ted-p-y").value = el.y;
  document.getElementById("ted-p-w").value = el.w;
  document.getElementById("ted-p-h").value = el.h;
  document.getElementById("ted-p-rotate").value = el.rotate || 0;
  document.getElementById("ted-p-opacity").value = el.style.opacity ?? 100;
  document.getElementById("ted-p-opacity-v").textContent = (el.style.opacity ?? 100) + "%";
  document.getElementById("ted-p-bg").value = el.style.bg && el.style.bg !== "transparent" ? el.style.bg : "#ffffff";
  document.getElementById("ted-p-radius").value = el.style.radius || 0;
  document.getElementById("ted-p-grad-to").value = el.style.gradTo || "#ffffff";
  document.getElementById("ted-p-grad-angle").value = el.style.gradTo ? String(el.style.gradAngle ?? 90) : "";
  const hasText = ["text", "badge", "chip"].includes(el.type);
  document.getElementById("ted-grp-text").hidden = !hasText;
  if (hasText) {
    document.getElementById("ted-p-content").value = el.style.content || "";
    document.getElementById("ted-p-fontSize").value = el.style.fontSize || 40;
    document.getElementById("ted-p-fontWeight").value = el.style.fontWeight || "400";
    document.getElementById("ted-p-color").value = el.style.color || "#1f2328";
    document.getElementById("ted-p-align").value = el.style.align || "left";
    document.getElementById("ted-p-lineHeight").value = el.style.lineHeight || 1.5;
    document.getElementById("ted-p-letterSpacing").value = el.style.letterSpacing || 0;
  }
}
function tedRenderOfficialList() {
  const wrap = document.getElementById("ted-official-list");
  wrap.innerHTML = "";
  TED_OFFICIAL_GROUPS.forEach((grp) => {
    const g = document.createElement("div");
    g.className = "grp";
    g.textContent = grp.group;
    wrap.appendChild(g);
    const list = document.createElement("div");
    list.className = "off-list";
    grp.templates.forEach((tpl) => {
      const item = document.createElement("div");
      item.className = "off-item";
      let selectedPage = "cover";
      item.innerHTML = `
        <div class="thumb"><img src="${tedSampleUrl(tpl, "cover")}" alt="${tpl.name}" loading="lazy"></div>
        <div class="info">
          <div class="head"><span class="nm">${tpl.name}</span><span class="en">${tpl.en}</span></div>
          <div class="page-seg">
            ${TED_PAGE_TYPES.map((p) => `<button data-page="${p.key}" class="${p.key === "cover" ? "active" : ""}" title="单击预览 · 双击以此页开始编辑">${p.name}</button>`).join("")}
          </div>
        </div>`;
      const thumb = item.querySelector(".thumb");
      const seg = item.querySelector(".page-seg");
      let segTimer = null;
      const markPage = (page) => {
        selectedPage = page;
        seg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
        thumb.innerHTML = `<img src="${tedSampleUrl(tpl, page)}" alt="${tpl.name}" loading="lazy">`;
      };
      seg.addEventListener("click", (event) => {
        const btn = event.target.closest("button[data-page]");
        if (!btn) return;
        event.stopPropagation();
        markPage(btn.dataset.page);
        clearTimeout(segTimer);
        segTimer = setTimeout(() => tedOpenBrowse(tpl, btn.dataset.page), 220);
      });
      seg.addEventListener("dblclick", (event) => {
        const btn = event.target.closest("button[data-page]");
        if (!btn) return;
        event.stopPropagation();
        clearTimeout(segTimer);
        tedUseTemplateAsEditable(tpl, btn.dataset.page);
      });
      item.addEventListener("click", () => tedOpenBrowse(tpl, selectedPage));
      list.appendChild(item);
    });
    wrap.appendChild(list);
  });
}
async function tedRenderTemplateList() {
  const list = document.getElementById("ted-tpl-list");
  list.innerHTML = "";
  let saved = [];
  try {
    const res = await api("/api/templates");
    saved = Array.isArray(res) ? res : [];
  } catch (e) {
    list.innerHTML = '<div class="empty-tip" style="padding:10px">模板列表加载失败。</div>';
    return;
  }
  saved.forEach((tpl) => {
    const item = document.createElement("div");
    item.className = "tpl-item";
    item.innerHTML = `
      <div class="thumb" style="${tpl.preview ? `background-image:url(${tpl.preview})` : ""}"></div>
      <div class="meta"><b>${String(tpl.name || "未命名模板").replace(/[<>&]/g, "")}</b><span>三页 · ${new Date(tpl.updatedAt || Date.now()).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
      <button class="del" title="删除模板">✕</button>`;
    item.addEventListener("click", async (event) => {
      if (event.target.closest(".del")) {
        try {
          await api(`/api/templates/${tpl.id}`, { method: "DELETE" });
          tedRenderTemplateList();
          // 同步刷新创作台模板选择器，被删模板立即从「我的模板」消失。
          if (typeof refreshCardStyles === "function") refreshCardStyles().catch(() => {});
          tedToast("模板已删除");
        } catch (e) {
          tedToast(`删除失败：${e.message}`);
        }
        return;
      }
      tedPushHistory();
      tedState.templateId = tpl.id;
      tedState.pages = JSON.parse(JSON.stringify(tpl.schema?.pages || {}));
      ["cover", "content", "ending"].forEach((k) => {
        if (!tedState.pages[k]) tedState.pages[k] = { canvas: { w: 1080, h: 1440 }, elements: [] };
      });
      tedState.selectedId = null;
      tedState.editingId = null;
      document.getElementById("ted-tpl-name").value = tpl.name || "未命名模板";
      tedApplyCanvasSize(false);
      tedRenderAll();
      tedToast(`已加载模板：${tpl.name}`);
    });
    list.appendChild(item);
  });
  if (!saved.length) {
    list.innerHTML = '<div class="empty-tip" style="padding:10px">还没有保存的模板。<br />编辑好后点右上角「保存模板」。</div>';
  }
}
function tedRenderAll() {
  tedRenderCanvas();
  tedRenderProps();
  tedRefreshHistoryButtons();
}
function tedSyncSizeSeg() {
  document.querySelectorAll("#ted-canvas-size-seg button").forEach((b) => {
    b.classList.toggle("active", b.dataset.size === `${tedCurPage().canvas.w}x${tedCurPage().canvas.h}`);
  });
}
/* 打开官方模板浏览（只读预览，可选中元素复制） */
function tedOpenBrowse(tpl, page) {
  tedState.browse = { tpl, page };
  tedState.selectedId = null;
  tedState.multiSel.clear();
  tedState.editingId = null;
  tedApplyCanvasSize(false);
  tedRenderAll();
}
/* 以官方模板某页为起点：整包复制成可编辑模板并定位到该页 */
function tedUseTemplateAsEditable(tpl, page) {
  tedState.browse = null;
  tedState.templateId = null;
  tedState.selectedId = null;
  tedState.multiSel.clear();
  tedState.editingId = null;
  tedState.currentPage = page;
  tedState.pages = {
    cover: { canvas: { w: 1080, h: 1440 }, elements: tedOfficialElements(tpl, "cover") },
    content: { canvas: { w: 1080, h: 1440 }, elements: tedOfficialElements(tpl, "content") },
    ending: { canvas: { w: 1080, h: 1440 }, elements: tedOfficialElements(tpl, "ending") },
  };
  document.getElementById("ted-tpl-name").value = `${tpl.name} · 我的版本`;
  document.querySelectorAll("#view-templates .ptab").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  tedSyncSizeSeg();
  tedApplyCanvasSize(false);
  tedRenderAll();
  tedToast(`已用「${tpl.name} · ${TED_PAGE_TYPES.find((p) => p.key === page).name}」开始编辑`);
}

/* ---------------- 页型切换 ---------------- */
function tedBindEvents() {
  document.querySelectorAll("#view-templates .ptab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll("#view-templates .ptab").forEach((b) => b.classList.toggle("active", b === tab));
      tedState.currentPage = tab.dataset.page;
      tedState.selectedId = null;
      tedState.multiSel.clear();
      tedState.editingId = null;
      if (tedState.browse) tedState.browse.page = tab.dataset.page;
      tedSyncSizeSeg();
      tedApplyCanvasSize(false);
      tedRenderAll();
    });
  });

  /* ---------------- 画布交互 ---------------- */
  const canvas = document.getElementById("ted-canvas");
  const stagePoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / tedState.scale, y: (event.clientY - rect.top) / tedState.scale };
  };
  canvas.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(".handle");
    const elNode = event.target.closest(".el");
    if (event.target.closest(".el.editing")) return;
    event.preventDefault();
    if (elNode) {
      const el = tedCurElements().find((e) => e.id === elNode.dataset.id);
      if (!el) return;
      if (event.shiftKey) {
        if (tedState.selectedId && !tedState.multiSel.has(tedState.selectedId) && tedState.multiSel.size === 0) tedState.multiSel.add(tedState.selectedId);
        if (tedState.multiSel.has(el.id)) tedState.multiSel.delete(el.id);
        else tedState.multiSel.add(el.id);
        tedState.selectedId = null;
        tedState.editingId = null;
        tedRenderCanvas();
        tedRenderProps();
        return;
      }
      if (!tedInBrowse()) {
        if (handle) { tedStartTransform(el, handle.dataset.handle, stagePoint(event), canvas); return; }
        if (tedState.selectedId !== el.id || tedState.multiSel.size) {
          tedState.selectedId = el.id; tedState.multiSel.clear(); tedState.editingId = null; tedRenderAll();
        }
        tedStartDrag(el, stagePoint(event), canvas);
        return;
      }
      if (tedState.selectedId !== el.id || tedState.multiSel.size) {
        tedState.selectedId = el.id; tedState.multiSel.clear(); tedRenderCanvas(); tedRenderProps();
      }
      return;
    }
    if (tedState.selectedId || tedState.multiSel.size) {
      tedState.selectedId = null; tedState.multiSel.clear(); tedState.editingId = null; tedRenderAll();
    }
  });
  let drag = null;
  window.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const p = { x: (event.clientX - rect.left) / tedState.scale, y: (event.clientY - rect.top) / tedState.scale };
    const el = drag.el;
    if (drag.mode === "move") {
      el.x = Math.round(drag.ox + (p.x - drag.sx));
      el.y = Math.round(drag.oy + (p.y - drag.sy));
    } else if (drag.handle === "rot") {
      const angle = Math.atan2(p.y - drag.ocy, p.x - drag.ocx) * 180 / Math.PI + 90;
      el.rotate = Math.round(angle) % 360;
    } else {
      const dx = p.x - drag.sx, dy = p.y - drag.sy;
      const h = drag.handle;
      if (h.includes("e")) el.w = Math.max(24, Math.round(drag.ow + dx));
      if (h.includes("s")) el.h = Math.max(24, Math.round(drag.oh + dy));
      if (h.includes("w")) { el.w = Math.max(24, Math.round(drag.ow - dx)); el.x = Math.round(drag.ox + Math.min(dx, drag.ow - 24)); }
      if (h.includes("n")) { el.h = Math.max(24, Math.round(drag.oh - dy)); el.y = Math.round(drag.oy + Math.min(dy, drag.oh - 24)); }
    }
    tedRenderCanvas();
    tedRenderProps();
  });
  window.addEventListener("pointerup", () => { if (drag) { tedPushHistory(); drag = null; } });
  window.__tedStartDrag = (el, p, c) => {
    drag = { mode: "move", el, sx: p.x, sy: p.y, ox: el.x, oy: el.y, ow: el.w, oh: el.h };
    c.setPointerCapture && c.setPointerCapture(event && event.pointerId);
  };

  canvas.addEventListener("dblclick", (event) => {
    if (tedInBrowse()) {
      tedUseTemplateAsEditable(tedState.browse.tpl, tedState.browse.page);
      return;
    }
    const elNode = event.target.closest(".el");
    if (elNode && elNode.classList.contains("text")) {
      tedState.selectedId = elNode.dataset.id;
      tedState.editingId = elNode.dataset.id;
      tedRenderAll();
      const node = canvas.querySelector(`.el[data-id="${elNode.dataset.id}"]`);
      if (node) node.focus();
      return;
    }
    if (!elNode) {
      const p = stagePoint(event);
      tedAddElement("text", p.x - 280, p.y - 70);
    }
  });
  canvas.addEventListener("focusout", (event) => {
    const node = event.target.closest && event.target.closest(".el.editing");
    if (!node) return;
    const el = tedCurElements().find((e) => e.id === node.dataset.id);
    if (el) {
      tedPushHistory();
      el.style.content = node.innerText.replace(/\n$/, "");
      tedState.editingId = null;
      tedRenderAll();
    }
  }, true);

  /* ---------------- 元素库 ---------------- */
  document.querySelectorAll("#ted-lib .lib-item").forEach((item) => {
    item.addEventListener("click", () => tedAddElement(item.dataset.add));
    item.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", item.dataset.add);
      event.dataTransfer.effectAllowed = "copy";
    });
    item.draggable = true;
  });
  const stage = document.getElementById("ted-stage");
  stage.addEventListener("dragover", (event) => event.preventDefault());
  stage.addEventListener("drop", (event) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData("text/plain");
    if (!kind || !TED_FACTORY[kind]) return;
    const p = stagePoint(event);
    tedAddElement(kind, p.x - 160, p.y - 90);
  });

  /* ---------------- 属性绑定 ---------------- */
  const bindProp = (id, apply) => {
    const input = document.getElementById(id);
    input.addEventListener("input", (event) => {
      const el = tedCurElements().find((e) => e.id === tedState.selectedId);
      if (!el) return;
      apply(el, event.target);
      tedRenderCanvas();
      if (id === "ted-p-opacity") document.getElementById("ted-p-opacity-v").textContent = event.target.value + "%";
    });
    input.addEventListener("change", () => { tedPushHistory(); tedRenderProps(); });
  };
  bindProp("ted-p-x", (el, t) => { el.x = +t.value || 0; });
  bindProp("ted-p-y", (el, t) => { el.y = +t.value || 0; });
  bindProp("ted-p-w", (el, t) => { el.w = Math.max(24, +t.value || 24); });
  bindProp("ted-p-h", (el, t) => { el.h = Math.max(24, +t.value || 24); });
  bindProp("ted-p-rotate", (el, t) => { el.rotate = +t.value || 0; });
  bindProp("ted-p-opacity", (el, t) => { el.style.opacity = +t.value; });
  bindProp("ted-p-bg", (el, t) => { el.style.bg = t.value; });
  bindProp("ted-p-radius", (el, t) => { el.style.radius = +t.value || 0; });
  bindProp("ted-p-content", (el, t) => { el.style.content = t.value; });
  bindProp("ted-p-fontSize", (el, t) => { el.style.fontSize = +t.value || 40; });
  bindProp("ted-p-fontWeight", (el, t) => { el.style.fontWeight = t.value; });
  bindProp("ted-p-color", (el, t) => { el.style.color = t.value; });
  bindProp("ted-p-align", (el, t) => { el.style.align = t.value; });
  bindProp("ted-p-lineHeight", (el, t) => { el.style.lineHeight = +t.value || 1.5; });
  bindProp("ted-p-letterSpacing", (el, t) => { el.style.letterSpacing = +t.value || 0; });
  bindProp("ted-p-grad-to", (el, t) => { el.style.gradTo = t.value; });
  bindProp("ted-p-grad-angle", (el, t) => {
    if (!t.value) { el.style.gradTo = ""; delete el.style.gradAngle; }
    else { el.style.gradTo = el.style.gradTo || "#ffffff"; el.style.gradAngle = +t.value; }
  });

  const selectedIds = () => {
    const ids = new Set(tedState.multiSel);
    if (tedState.selectedId) ids.add(tedState.selectedId);
    return [...ids];
  };
  function copySelection() {
    const els = tedCurElements().filter((e) => selectedIds().includes(e.id));
    if (!els.length) { tedToast("先选中要复制的元素"); return; }
    tedState.clipboard = JSON.parse(JSON.stringify(els));
    tedToast(tedState.clipboard.length > 1 ? `已复制 ${tedState.clipboard.length} 个元素` : "已复制 1 个元素，到目标页 Ctrl+V 粘贴");
  }
  async function pasteClipboard() {
    if (tedInBrowse()) { tedToast("浏览模式不能粘贴，点「返回编辑」后再 Ctrl+V"); return; }
    if (!tedState.clipboard.length) { tedToast("剪贴板是空的，先复制元素"); return; }
    tedPushHistory();
    const base = tedCurElements().length;
    const pasted = tedState.clipboard.map((el, i) => {
      const copy = JSON.parse(JSON.stringify(el));
      copy.id = tedNewId(el.type);
      copy.x += 28; copy.y += 28;
      copy.z = base + i + 1;
      return copy;
    });
    tedCurPage().elements.push(...pasted);
    tedState.selectedId = pasted[pasted.length - 1].id;
    tedState.multiSel.clear();
    tedState.editingId = null;
    tedRenderAll();
    tedToast(`已粘贴 ${pasted.length} 个元素`);
  }
  document.getElementById("ted-p-delete").addEventListener("click", () => {
    const ids = selectedIds();
    if (!ids.length) return;
    tedPushHistory();
    tedState.pages[tedState.currentPage].elements = tedCurElements().filter((e) => !ids.includes(e.id));
    tedState.selectedId = null;
    tedState.multiSel.clear();
    tedRenderAll();
  });
  document.getElementById("ted-p-duplicate").addEventListener("click", () => {
    const el = tedCurElements().find((e) => e.id === tedState.selectedId);
    if (!el) return;
    tedPushHistory();
    const copy = JSON.parse(JSON.stringify(el));
    copy.id = tedNewId(el.type);
    copy.x += 40; copy.y += 40; copy.z = (el.z || 1) + 1;
    tedCurElements().push(copy);
    tedState.selectedId = copy.id;
    tedRenderAll();
  });
  document.getElementById("ted-p-copy").addEventListener("click", copySelection);
  document.getElementById("ted-p-paste").addEventListener("click", pasteClipboard);
  document.getElementById("ted-browse-exit").addEventListener("click", () => {
    tedState.browse = null;
    tedState.selectedId = null;
    tedState.multiSel.clear();
    tedState.editingId = null;
    tedApplyCanvasSize(false);
    tedRenderAll();
    tedToast("已返回编辑自己的模板");
  });
  document.getElementById("ted-browse-use").addEventListener("click", () => {
    if (!tedState.browse) return;
    tedUseTemplateAsEditable(tedState.browse.tpl, tedState.browse.page);
  });
  function moveLayer(dir) {
    const el = tedCurElements().find((e) => e.id === tedState.selectedId);
    if (!el) return;
    tedPushHistory();
    el.z = dir > 0 ? (el.z || 1) + 1 : Math.max(1, (el.z || 1) - 1);
    tedRenderAll();
  }
  document.getElementById("ted-p-layer-up").addEventListener("click", () => moveLayer(1));
  document.getElementById("ted-p-layer-down").addEventListener("click", () => moveLayer(-1));

  /* ---------------- 画布尺寸 ---------------- */
  document.getElementById("ted-canvas-size-seg").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-size]");
    if (!btn) return;
    document.querySelectorAll("#ted-canvas-size-seg button").forEach((b) => b.classList.toggle("active", b === btn));
    const [w, h] = btn.dataset.size.split("x").map(Number);
    tedCurPage().canvas = { w, h };
    tedState.selectedId = null;
    tedApplyCanvasSize();
    tedRenderAll();
  });

  /* ---------------- 保存 / 预览 / 撤销重做 ---------------- */
  document.getElementById("ted-save").addEventListener("click", async () => {
    if (tedInBrowse()) { tedToast("浏览态不能保存，先点「用此页开始编辑」"); return; }
    const name = document.getElementById("ted-tpl-name").value.trim() || "未命名模板";
    const payload = {
      name,
      schema: { pages: JSON.parse(JSON.stringify(tedState.pages)) },
      preview: tedCanvasDataUrl(),
    };
    try {
      if (tedState.templateId) {
        await api(`/api/templates/${tedState.templateId}`, { method: "PUT", body: payload });
      } else {
        const created = await api("/api/templates", { method: "POST", body: payload });
        tedState.templateId = created.id;
      }
      tedRenderTemplateList();
      // 同步刷新创作台模板选择器（design/styles 含 custom:<id>），否则要手动刷新页面才能看到。
      if (typeof refreshCardStyles === "function") refreshCardStyles().catch(() => {});
      tedToast(`模板「${name}」已保存（含三页），创作台「我的模板」可选它出图`);
    } catch (e) {
      tedToast(`保存失败：${e.message}`);
    }
  });
  document.getElementById("ted-undo").addEventListener("click", tedUndo);
  document.getElementById("ted-redo").addEventListener("click", tedRedo);

  const SAMPLE_FILL = {
    "{标题}": "秋招复盘：3 个真有用的面试方法",
    "{正文摘要}": "从简历改法到终面反问，把这一年踩过的坑整理成一份清单。",
    "{日期}": new Date().toISOString().slice(0, 10),
    "{结尾金句}": "方法不对，努力白费",
  };
  function renderPreviewInto(canvasEl, frameEl) {
    canvasEl.querySelectorAll(".el").forEach((n) => n.remove());
    tedCurElements()
      .slice()
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .forEach((el) => {
        const copy = JSON.parse(JSON.stringify(el));
        if (copy.type === "text" || copy.type === "badge" || copy.type === "chip") {
          let text = copy.style.content || "";
          Object.entries(SAMPLE_FILL).forEach(([k, v]) => { text = text.split(k).join(v); });
          copy.style.content = text || "占位文本";
        }
        canvasEl.appendChild(tedCreateElNode(copy, false));
      });
    const { w, h } = tedCurPage().canvas;
    const availW = Math.min(560, window.innerWidth - 120);
    const availH = window.innerHeight - 220;
    const scale = Math.min(availW / w, availH / h, 1);
    frameEl.style.width = w * scale + "px";
    frameEl.style.height = h * scale + "px";
    canvasEl.style.width = w + "px";
    canvasEl.style.height = h + "px";
    canvasEl.style.transform = `scale(${scale})`;
  }
  document.getElementById("ted-preview").addEventListener("click", () => {
    renderPreviewInto(document.getElementById("ted-preview-canvas"), document.getElementById("ted-preview-frame"));
    document.getElementById("ted-preview-use").hidden = !tedInBrowse();
    document.getElementById("ted-preview-modal").hidden = false;
  });
  document.getElementById("ted-preview-close").addEventListener("click", () => { document.getElementById("ted-preview-modal").hidden = true; });
  document.getElementById("ted-preview-use").addEventListener("click", () => {
    if (!tedState.browse) return;
    const tpl = tedState.browse.tpl;
    const page = tedState.browse.page;
    document.getElementById("ted-preview-modal").hidden = true;
    tedUseTemplateAsEditable(tpl, page);
  });
  document.getElementById("ted-preview-modal").addEventListener("click", (event) => {
    if (event.target === document.getElementById("ted-preview-modal")) document.getElementById("ted-preview-modal").hidden = true;
  });

  /* ---------------- 键盘 ---------------- */
  window.addEventListener("keydown", (event) => {
    if (!document.getElementById("view-templates").classList.contains("active")) return;
    const tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || event.target.isContentEditable) return;
    if (event.ctrlKey && event.key.toLowerCase() === "z") { event.preventDefault(); tedUndo(); return; }
    if (event.ctrlKey && event.key.toLowerCase() === "y") { event.preventDefault(); tedRedo(); return; }
    if (event.ctrlKey && event.key.toLowerCase() === "c") { event.preventDefault(); copySelection(); return; }
    if (event.ctrlKey && event.key.toLowerCase() === "v") { event.preventDefault(); pasteClipboard(); return; }
    if (event.ctrlKey && event.key.toLowerCase() === "d") { event.preventDefault(); document.getElementById("ted-p-duplicate").click(); return; }
    if (tedInBrowse()) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      if (selectedIds().length) { event.preventDefault(); document.getElementById("ted-p-delete").click(); }
      return;
    }
    const el = tedCurElements().find((e) => e.id === tedState.selectedId);
    if (!el) return;
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft") { event.preventDefault(); el.x -= step; tedRenderCanvas(); tedRenderProps(); }
    if (event.key === "ArrowRight") { event.preventDefault(); el.x += step; tedRenderCanvas(); tedRenderProps(); }
    if (event.key === "ArrowUp") { event.preventDefault(); el.y -= step; tedRenderCanvas(); tedRenderProps(); }
    if (event.key === "ArrowDown") { event.preventDefault(); el.y += step; tedRenderCanvas(); tedRenderProps(); }
  });

  window.addEventListener("resize", () => {
    if (document.getElementById("view-templates").classList.contains("active")) tedApplyCanvasSize(false);
  });
}

/* 画布导出 dataURL（模板缩略图） */
function tedCanvasDataUrl() {
  try {
    const frame = document.getElementById("ted-canvas-frame");
    const canvas = document.getElementById("ted-canvas");
    const { w, h } = tedCurPage().canvas;
    const exportCanvas = document.createElement("canvas");
    const scale = Math.min(320 / w, 420 / h, 1);
    exportCanvas.width = Math.round(w * scale);
    exportCanvas.height = Math.round(h * scale);
    const ctx = exportCanvas.getContext("2d");
    ctx.scale(scale, scale);
    /* DOM → canvas 简化：只画背景色 + 元素矩形/文字（缩略图够用） */
    const els = tedCurElements().slice().sort((a, b) => (a.z || 0) - (b.z || 0));
    for (const el of els) {
      const s = el.style || {};
      const grad = s.gradTo ? `linear-gradient(${s.gradAngle || 90}deg, ${s.bg || "#e8503a"}, ${s.gradTo})` : "";
      ctx.save();
      ctx.globalAlpha = (s.opacity ?? 100) / 100;
      ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
      ctx.rotate(((el.rotate || 0) * Math.PI) / 180);
      ctx.translate(-(el.x + el.w / 2), -(el.y + el.h / 2));
      if (["shape", "circle", "divider", "image"].includes(el.type)) {
        ctx.fillStyle = grad || s.bg || "#e8503a";
        const r = Math.min(Number(s.radius) || 0, el.w / 2, el.h / 2);
        ctx.beginPath();
        ctx.roundRect(el.x, el.y, el.w, el.h, el.type === "circle" ? Math.min(el.w, el.h) / 2 : r);
        ctx.fill();
      } else if (["text", "badge", "chip"].includes(el.type)) {
        let text = String(s.content || "");
        if (["text", "badge", "chip"].includes(el.type)) {
          text = text.split("{标题}").join("标题文本").split("{正文摘要}").join("摘要文本").split("{日期}").join("2026-01-01").split("{结尾金句}").join("金句");
        }
        ctx.font = `${s.fontWeight || 400} ${Math.min(Number(s.fontSize) || 40, 72)}px "Microsoft YaHei",sans-serif`;
        ctx.fillStyle = s.color || (el.type === "text" ? "#1f2328" : "#ffffff");
        ctx.textBaseline = "top";
        const lines = text.split("\n").slice(0, 4);
        lines.forEach((line, i) => ctx.fillText(line.slice(0, 22), el.x + 4, el.y + 6 + i * (Number(s.fontSize) || 40) * 1.3));
      }
      ctx.restore();
    }
    void frame; void canvas;
    return exportCanvas.toDataURL("image/png");
  } catch (e) {
    return "";
  }
}

/* ---------------- 入口：首次进入模板页时初始化 ---------------- */
async function initTemplateEditor() {
  if (tedState.loaded) return;
  tedState.loaded = true;
  tedBindEvents();
  tedRenderOfficialList();
  ensureOfficialSamples();
  await tedRenderTemplateList();
  /* 默认载入：知识卡片首页 */
  tedState.pages.cover.elements = tedOfficialElements(TED_OFFICIAL_GROUPS[0].templates[0], "cover");
  tedApplyCanvasSize(false);
  const stage = document.getElementById("ted-stage");
  if (stage && typeof ResizeObserver === "function") {
    new ResizeObserver(() => tedFitCanvas()).observe(stage);
  }
  tedRenderAll();
}
