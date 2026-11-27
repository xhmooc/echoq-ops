# encoding: utf-8
"""把用户上传的原型复制进 film/assets/prototype。
注入内容：
1. hash 引导：#view=<name> 切视图、#preview=1 打开三端预览、自动跳过首启引导、3s 冻结 CSS 动画。
2. window.__protoCue(t)：渲染器逐帧调用的编排引擎——选题卡逐张弹入+热度环计数、
   文案逐字生成（状态百分比同步）、内容库封面逐张浮现+新图高亮、三端预览手机逐台升起、
   发布队列状态逐条翻转（排队中→发布中→已发布）。全部状态是 t 的纯函数，保证逐帧渲染确定性。
"""
from pathlib import Path

SRC = Path(r"c:\Users\徐豪\.trae-cn\attachments\3cd210a3-5914-4571-977b-47415d9243df_538e092e-6374-49b6-b794-0829fc9ba4f8_index.html")
DST_DIR = Path(r"D:\Projects\EchoQ-Ops\promo-video\film\assets\prototype")
DST = DST_DIR / "index.html"

BOOTSTRAP = r"""
<script>
/* ===== promo-video 引导 + 逐帧编排引擎 ===== */
(function () {
  /* ---------- hash 引导 ---------- */
  function nav(name) {
    var b = document.querySelector('.nav-item[data-view="' + name + '"]');
    if (b) b.click();
  }
  function boot() {
    var m = location.hash.match(/view=([a-zA-Z-]+)/);
    var name = m ? m[1] : null;
    if (name) nav(name);
    var tries = 0;
    (function dismiss() {
      var layer = document.getElementById('onb-layer');
      if (layer && !layer.hidden) {
        var s = document.getElementById('onb-skip');
        if (s) s.click();
        if (name) setTimeout(function () { nav(name); }, 150);
      } else if (++tries < 20) {
        setTimeout(dismiss, 300);
      }
    })();
    if (location.hash.indexOf('preview=1') >= 0) {
      setTimeout(function () {
        var b = document.getElementById('preview-all');
        if (b) b.click();
      }, 1500);
    }
    setTimeout(function () {
      var st = document.createElement('style');
      st.textContent = '*,*::before,*::after{animation-play-state:paused !important;transition:none !important}';
      document.head.appendChild(st);
    }, 3000);
  }
  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);

  /* ---------- 编排工具 ---------- */
  function seg(t, a, b) { return Math.max(0, Math.min(1, (t - a) / (b - a))); }
  function ease(p) { return 1 - Math.pow(1 - p, 3); }
  function setFade(el, p, dy) {
    el.style.opacity = p;
    el.style.transform = 'translateY(' + ((1 - p) * (dy || 26)) + 'px)';
  }

  /* ---------- 站 1 · 选题池 ---------- */
  function cueTopics(t) {
    var cards = document.querySelectorAll('#view-topics .topic-card');
    cards.forEach(function (card, i) {
      var p = ease(seg(t, 5.75 + i * 0.18, 5.75 + i * 0.18 + 0.34));
      setFade(card, p, 30);
      var score = card.querySelector('.tc-score');
      if (!score) return;
      if (card.__v0 === undefined) {
        var mv = (score.getAttribute('style') || '').match(/--v:\s*(\d+)/);
        card.__v0 = mv ? parseInt(mv[1], 10) : 80;
        var bar = card.querySelector('.tc-heat .bar i');
        var mw = bar ? (bar.getAttribute('style') || '').match(/width:\s*(\d+)/) : null;
        card.__w0 = mw ? parseInt(mw[1], 10) : 70;
      }
      var q = ease(seg(t, 6.35 + i * 0.1, 6.35 + i * 0.1 + 2.1));
      var v = Math.round(card.__v0 * q);
      score.style.setProperty('--v', v);
      var b = score.querySelector('b');
      if (b) b.textContent = v;
      var bar = card.querySelector('.tc-heat .bar i');
      if (bar) bar.style.width = (card.__w0 * q) + '%';
      var heat = card.querySelector('.tc-heat .n');
      if (heat && card.__h0 === undefined) {
        var mh = (heat.textContent || '').match(/([\d,]+)/);
        card.__h0 = mh ? parseInt(mh[1].replace(/,/g, ''), 10) : 5000;
      }
      if (heat && card.__h0) heat.textContent = '热度 ' + Math.round(card.__h0 * q).toLocaleString();
    });
    if (cards[0]) {
      var pill = cards[0].querySelector('.pill');
      if (pill) {
        if (card_pill0 === undefined) card_pill0 = { cls: pill.className, txt: pill.textContent };
        if (t >= 9.4) { pill.className = 'pill ok'; pill.textContent = '已选用'; }
        else { pill.className = card_pill0.cls; pill.textContent = card_pill0.txt; }
      }
    }
  }
  var card_pill0;

  /* ---------- 站 2 · 创作台（AI 逐字生成） ---------- */
  function cueStudio(t) {
    var editor = document.querySelector('#view-studio .editor-body');
    var status = document.getElementById('ai-status');
    var aiBtn = document.getElementById('ai-gen');
    if (editor) {
      if (editor.__full === undefined) editor.__full = editor.value;
      var full = editor.__full;
      var p = seg(t, 12.0, 15.0);
      var n = Math.round(full.length * p);
      editor.value = full.slice(0, n);
      editor.scrollTop = editor.scrollHeight;
      if (status) {
        if (t < 12.0) status.textContent = '本地模型已就绪';
        else if (p < 1) status.textContent = '正在生成 ' + Math.round(p * 100) + '%';
        else status.textContent = '已生成 · ' + full.length + ' 字 · 3s';
      }
      if (aiBtn) {
        if (aiBtn.__html0 === undefined) aiBtn.__html0 = aiBtn.innerHTML;
        aiBtn.innerHTML = (t >= 12.0 && p < 1)
          ? '<svg class="ico" width="13" height="13"><use href="#i-x"></use></svg>停止生成'
          : aiBtn.__html0;
      }
    }
    var title = document.querySelector('#view-studio .editor-title') ||
                document.querySelector('#view-studio input[maxlength="20"]');
    if (title) {
      if (title.__full === undefined) title.__full = title.value || '秋招复盘：真正有用的 3 个动作';
      var tp = seg(t, 11.9, 12.8);
      title.value = title.__full.slice(0, Math.round(title.__full.length * tp));
      var muted = title.closest('.set-block');
      if (muted) {
        var m = muted.querySelector('.muted');
        if (m) m.textContent = title.value.length + ' / 20';
      }
    }
  }

  /* ---------- 站 3 · 内容库（封面墙） ---------- */
  function cueLibrary(t) {
    var grid = document.querySelector('#view-library .lib-grid');
    if (!grid) return;
    var cards = grid.children;
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      var p = ease(seg(t, 17.15 + i * 0.09, 17.15 + i * 0.09 + 0.3));
      setFade(c, p, 24);
      var hot = (i === 2 && t >= 19.2);
      c.style.transform = hot ? 'scale(1.05)' : (p < 1 ? c.style.transform : '');
      c.style.boxShadow = hot ? '0 18px 44px rgba(255,36,66,.28)' : '';
      c.style.outline = hot ? '2px solid var(--brand,#ff2442)' : '';
      var chk = c.querySelector('.cc-check');
      if (chk) chk.style.opacity = hot ? 1 : '';
    }
  }

  /* ---------- 站 4 · 三端预览（真机平台切换） ---------- */
  var curPlatBtn = null;
  function cuePreviewSwitch(t) {
    var switches = [[23.2, 'dy'], [24.5, 'wx'], [25.8, 'xhs']];
    var cur = 'xhs';
    for (var i = 0; i < switches.length; i++) {
      if (t >= switches[i][0]) cur = switches[i][1];
    }
    var btn = document.querySelector('.plat-seg button[data-preview="' + cur + '"]');
    if (btn && btn !== curPlatBtn) {
      btn.click();
      curPlatBtn = btn;
    }
    /* 切换瞬间手机外圈红晕脉冲 */
    var dev = document.getElementById('device');
    if (dev) {
      var last = 0;
      for (var j = 0; j < switches.length; j++) {
        if (t >= switches[j][0]) last = switches[j][0];
      }
      var a = t >= last ? Math.max(0, 1 - (t - last) / 0.7) : 0;
      dev.style.boxShadow = a > 0 ? '0 0 0 ' + Math.round(6 * a) + 'px rgba(255,36,66,' + (0.35 * a).toFixed(3) + ')' : '';
    }
    /* 抖音视图里进度条持续走动 */
    var prog = document.querySelector('#device .dy-progress i');
    if (prog && cur === 'dy') prog.style.width = ((t * 31) % 100) + '%';
  }

  /* ---------- 站 5 · 发布队列 ---------- */
  function cueQueue(t) {
    var rows = document.querySelectorAll('#view-queue .q-row');
    var published = 0;
    rows.forEach(function (row, i) {
      if (i > 3) return;
      var pill = row.querySelector('.pill');
      if (!pill) return;
      if (row.__p0 === undefined) row.__p0 = { cls: pill.className, txt: pill.textContent };
      var tp = 28.55 + i * 0.55;
      if (t >= tp + 0.45) {
        pill.className = 'pill ok'; pill.textContent = '已发布'; published++;
      } else if (t >= tp) {
        pill.className = 'pill warn'; pill.textContent = '发布中';
      } else {
        pill.className = row.__p0.cls; pill.textContent = row.__p0.txt;
      }
      var a = t >= tp ? Math.max(0, 1 - (t - tp) / 0.6) : 0;
      row.style.backgroundColor = a > 0 ? 'rgba(255,36,66,' + (0.07 * a).toFixed(3) + ')' : '';
    });
    var ns = document.querySelectorAll('#view-queue .strip-note b');
    if (ns.length >= 3) {
      ns[0].textContent = Math.max(0, 8 - published);
      ns[2].textContent = t >= 31.4 ? 0 : 2;
    }
  }

  /* ---------- 入口 ---------- */
  window.__protoCue = function (t) {
    try {
      var hash = location.hash;
      var view = (hash.match(/view=([a-zA-Z-]+)/) || [, 'home'])[1];
      if (view === 'topics') cueTopics(t);
      else if (view === 'studio' && hash.indexOf('mode=switch') >= 0) cuePreviewSwitch(t);
      else if (view === 'studio') cueStudio(t);
      else if (view === 'library') cueLibrary(t);
      else if (view === 'queue') cueQueue(t);
    } catch (e) {}
  };

  /* ---------- 特写镜头：实测元素区域，返回该时刻相机应对准的矩形 ---------- */
  function roiOf(els, padX, padY) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    els.forEach(function (el) {
      if (!el) return;
      var r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    });
    if (x0 >= x1) return null;
    x0 -= padX; y0 -= padY; x1 += padX; y1 += padY;
    /* 裁成 930:523（≈1.778）视窗比：窄了扩宽、扁了扩高 */
    var w = x1 - x0, h = y1 - y0;
    if (w / h < 1.778) { var nw = h * 1.778; x0 -= (nw - w) / 2; x1 = x0 + nw; }
    else { var nh = w / 1.778; y0 -= (nh - h) / 2; y1 = y0 + nh; }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(1920, x1); y1 = Math.min(1080, y1);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  window.__protoRoi = function (t) {
    try {
      var hash = location.hash;
      var view = (hash.match(/view=([a-zA-Z-]+)/) || [, 'home'])[1];
      var win = null, roi = null;
      if (view === 'topics') {
        win = [6.3, 7.5];
        roi = roiOf([].slice.call(document.querySelectorAll('#view-topics .topic-card'), 0, 4), 34, 28);
      } else if (view === 'studio' && hash.indexOf('mode=switch') >= 0) {
        win = [22.7, 23.9];
        roi = roiOf([document.getElementById('device')], 48, 36);
      } else if (view === 'studio') {
        win = [11.9, 13.1];
        var ai = document.getElementById('ai-status');
        roi = roiOf([ai ? (ai.closest('.card') || ai.parentElement) : null,
                     document.querySelector('#view-studio .editor-body')], 44, 32);
      } else if (view === 'library') {
        win = [17.2, 18.4];
        roi = roiOf([].slice.call(document.querySelectorAll('#view-library .lib-grid').children, 0, 2), 32, 26);
      } else if (view === 'queue') {
        win = [28.3, 29.5];
        var rows = document.querySelectorAll('#view-queue .q-row');
        roi = roiOf([
          rows[0] ? rows[0].querySelector('.q-info') : null,
          rows[0] ? rows[0].querySelector('.pill') : null,
          rows[1] ? rows[1].querySelector('.q-info') : null,
          rows[1] ? rows[1].querySelector('.pill') : null
        ], 70, 46);
      }
      if (!roi) return null;
      var p = ease(seg(t, win[0], win[1]));
      return { x: roi.x * p, y: roi.y * p, w: 1920 + (roi.w - 1920) * p, h: 1080 + (roi.h - 1080) * p };
    } catch (e) { return null; }
  };
})();
</script>
</body>"""


def main() -> int:
    DST_DIR.mkdir(parents=True, exist_ok=True)
    html = SRC.read_text(encoding="utf-8")
    idx = html.rfind("</body>")
    if idx < 0:
        raise SystemExit("no </body> found")
    html = html[:idx] + BOOTSTRAP + html[idx + len("</body>"):]
    DST.write_text(html, encoding="utf-8")
    print(f"written: {DST} ({DST.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
