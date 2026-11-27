/**
 * M3-b 动效范式脚本工厂：5 种范式的 __seek(t) 确定性实现，
 * 三代模板（旧版式 / V2 / 手绘）共用同一套逻辑，只是选择器不同。
 *
 * 契约（与 M1 动效一致）：
 *  - 页面不使用 CSS animation，画面是 t 的纯函数——同 t 同像素，禁止读时钟；
 *  - 注入的 duration/选择器全部为字面量，无外部输入拼接风险（选择器来自代码内常量）。
 */

export interface MotionScriptSpec {
  /** 范式 key（motion.ts MOTION_TEMPLATES 白名单成员） */
  template: string;
  /** 时长（秒），决定进度条与错峰节奏 */
  duration: number;
  /** 参与入场的叶子元素选择器 */
  els: string;
  /** 标题选择器（type-in 逐字浮现的作用对象） */
  title?: string;
  /** 角标/印章选择器（pop-sticker 抖动对象） */
  badges?: string;
  /** 插画层选择器（kenburns 缩放 / sketch-grow 揭示的优先目标） */
  art?: string;
}

/**
 * 生成完整动效脚本（IIFE）。paradigm 一览：
 *  - fade-seq    元素错峰淡入 + 上移 26px + 底部进度条（0.2.9 默认行为）
 *  - type-in     标题按字符 stagger 显现，其余元素在其完成后错峰入场
 *  - kenburns    画面缓推（scale 1→1.06/1.08，插画层优先），文字错峰淡入
 *  - sketch-grow 插画层自上而下 clip 揭示（无插画层时降级为 fade-seq）
 *  - pop-sticker 元素弹簧缩放入场（easeOutBack 过冲），角标衰减抖动
 */
export function buildMotionScript(spec: MotionScriptSpec): string {
  const duration = Math.max(1, Math.round(spec.duration));
  const tpl = JSON.stringify(spec.template);
  const els = JSON.stringify(spec.els);
  const titleSel = JSON.stringify(spec.title || "");
  const badgesSel = JSON.stringify(spec.badges || "");
  const artSel = JSON.stringify(spec.art || "");
  return `
(function(){
  var page = document.querySelector('.page');
  window.__recording = false;
  if (!page) { window.__seek = function(){}; window.__ready = true; return; }
  var bar = document.getElementById('motion-bar');
  var TPL = ${tpl};
  var D = ${duration};
  var k = D / 6;
  var SEL = ${els};
  var els = Array.prototype.filter.call(page.querySelectorAll(SEL), function(el){
    return !el.querySelector(SEL);
  });
  var title = ${titleSel} ? page.querySelector(${titleSel}) : null;
  var badges = ${badgesSel} ? Array.prototype.slice.call(page.querySelectorAll(${badgesSel})) : [];
  var art = ${artSel} ? page.querySelector(${artSel}) : null;
  function seg(t, a, b){ return Math.max(0, Math.min(1, (t - a) / (b - a))); }
  function ease(u){ return 1 - Math.pow(1 - u, 3); }
  function backOut(u){ var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2); }
  var badgeSet = new Set(badges);
  var chars = [];
  var probeTarget = null;
  if (TPL === 'type-in' && title) {
    var text = title.textContent || '';
    title.textContent = '';
    Array.from(text).forEach(function(ch){
      var s = document.createElement('span');
      s.textContent = ch;
      s.style.display = 'inline-block';
      s.style.opacity = '0';
      title.appendChild(s);
      chars.push(s);
    });
  }
  if (TPL === 'kenburns') {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    probeTarget = art || page;
  }
  /* 镜头类范式的布局体检复位：测文字块前撤掉刻意的画面缩放 */
  window.__probeReset = function(){
    if (probeTarget) probeTarget.style.transform = 'none';
  };
  /* 元素 i 的分数式入场窗口：全部在 [from, to] 比例区间内完成（元素数无关） */
  function fracWindow(i, n, from, to){
    var a = D * (from + (to - from) * i / n);
    return [a, a + D * (to - from) / n + 0.02];
  }
  /* pop-sticker 的角标由 wobbleBadges 专管；type-in 的标题由逐字逻辑专管，均跳过 */
  function skipped(el){
    return (TPL === 'pop-sticker' && badgeSet.has(el)) || (TPL === 'type-in' && el === title);
  }
  function fadeEls(t, from, to, lift){
    for (var i = 0; i < els.length; i++){
      var el = els[i];
      if (skipped(el)) continue;
      var w = fracWindow(i, els.length, from, to);
      var u = ease(seg(t, w[0], w[1]));
      el.style.opacity = String(u);
      el.style.transform = 'translateY(' + ((1 - u) * lift).toFixed(1) + 'px)';
    }
  }
  function fadeSeqEls(t){
    for (var i = 0; i < els.length; i++){
      var el = els[i];
      if (skipped(el)) continue;
      var u = ease(seg(t, (0.10 + i * 0.26) * k, (0.70 + i * 0.26) * k));
      el.style.opacity = String(u);
      el.style.transform = 'translateY(' + ((1 - u) * 26).toFixed(1) + 'px)';
    }
  }
  function popEls(t){
    for (var i = 0; i < els.length; i++){
      var el = els[i];
      if (badgeSet.has(el)) continue;
      var s0 = (0.08 + i * 0.22) * k;
      var u = seg(t, s0, s0 + 0.5 * k);
      el.style.opacity = String(Math.min(1, u * 2.5));
      el.style.transform = 'scale(' + (0.6 + 0.4 * backOut(u)).toFixed(3) + ')';
    }
  }
  function wobbleBadges(t){
    for (var i = 0; i < badges.length; i++){
      var bd = badges[i];
      var s0 = (0.30 + i * 0.22) * k;
      var u = seg(t, s0, s0 + 0.5 * k);
      var dt = t - (s0 + 0.5 * k);
      var ang = dt > 0 ? Math.sin(dt * 10) * Math.exp(-dt * 2.2) * 5 : 0;
      bd.style.opacity = String(Math.min(1, u * 2.5));
      bd.style.transform = 'rotate(' + ang.toFixed(2) + 'deg) scale(' + (0.6 + 0.4 * backOut(u)).toFixed(3) + ')';
    }
  }
  window.__seek = function(t){
    if (TPL === 'type-in') {
      var n = chars.length;
      var t0 = D * 0.12, t1 = D * 0.62;
      var span = Math.max(0, t1 - t0 - 0.3);
      var step = n > 1 ? span / (n - 1) : 0;
      for (var i = 0; i < n; i++){
        var u = ease(seg(t, t0 + i * step, t0 + i * step + 0.3));
        chars[i].style.opacity = String(u);
        chars[i].style.transform = 'translateY(' + ((1 - u) * 12).toFixed(1) + 'px)';
      }
      if (title) { title.style.opacity = '1'; title.style.transform = 'none'; }
      fadeEls(t, 0.62, 0.92, 26);
    } else if (TPL === 'kenburns') {
      var target = art || page;
      var maxS = art ? 1.08 : 1.06;
      var s = 1 + (maxS - 1) * ease(seg(t, 0, D * 0.9));
      target.style.transformOrigin = 'center center';
      target.style.transform = 'scale(' + s.toFixed(4) + ')';
      fadeEls(t, 0.15, 0.85, 18);
    } else if (TPL === 'sketch-grow') {
      if (art) {
        var p = ease(seg(t, 0, D * 0.7));
        var clip = 'inset(0 0 ' + (100 - p * 100).toFixed(2) + '% 0)';
        art.style.clipPath = clip;
        art.style.webkitClipPath = clip;
        fadeEls(t, 0.35, 0.95, 22);
      } else {
        fadeSeqEls(t);
      }
    } else if (TPL === 'pop-sticker') {
      popEls(t);
      wobbleBadges(t);
    } else {
      fadeSeqEls(t);
    }
    if (bar) bar.style.width = (Math.min(1, t / D) * 100).toFixed(2) + '%';
  };
  window.__seek(0);
  window.__ready = true;
})();`;
}
