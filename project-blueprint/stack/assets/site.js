/*
  Shared rendering, navigation, search, and Ask-agent logic for every page
  in this knowledge base. Loaded after assets/stack.js via a classic
  <script> tag — references the bare `STACK` identifier, never
  `window.STACK`. No ES modules, no fetch() of local files, no CDN: this
  all has to work opened straight from disk over file://.
*/
var Site = (function () {
  "use strict";

  var STOPWORDS = new Set(["the","a","an","of","to","and","or","in","on","for","with","is","are","this","that","it","as","by","be","was","were","from","at","into","over","which","who","what","when","how","why","not","no","so","if","than","then","its","their","them","these","those","you","your","using"]);

  /* ------------------------------------------------------------------ */
  /* Utilities                                                          */
  /* ------------------------------------------------------------------ */

  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function tokenize(text) {
    return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(function (w) {
      return w.length > 1 && !STOPWORDS.has(w);
    });
  }

  function stem(w) {
    if (w.length > 5 && w.slice(-3) === "ing") return w.slice(0, -3);
    if (w.length > 5 && w.slice(-3) === "ies") return w.slice(0, -3) + "y";
    if (w.length > 5 && w.slice(-3) === "ied") return w.slice(0, -3) + "y";
    if (w.length > 4 && w.slice(-2) === "ed") return w.slice(0, -2);
    if (w.length > 4 && w.slice(-2) === "es") return w.slice(0, -2);
    if (w.length > 3 && w.slice(-1) === "s") return w.slice(0, -1);
    return w;
  }

  function highlight(text, terms) {
    var escaped = escapeHtml(text);
    var unique = Array.from(new Set(terms.filter(function (t) { return t && t.length > 1; })))
      .sort(function (a, b) { return b.length - a.length; });
    unique.forEach(function (t) {
      var re = new RegExp("(" + escapeRegex(escapeHtml(t)) + ")", "ig");
      escaped = escaped.replace(re, "<mark>$1</mark>");
    });
    return escaped;
  }

  function makeSnippet(text, terms) {
    text = String(text || "");
    var lower = text.toLowerCase();
    var idxFound = -1;
    terms.forEach(function (t) {
      var i = lower.indexOf(t.toLowerCase());
      if (i >= 0 && (idxFound < 0 || i < idxFound)) idxFound = i;
    });
    if (idxFound < 0) idxFound = 0;
    var start = Math.max(0, idxFound - 50);
    var end = Math.min(text.length, idxFound + 130);
    var snippet = (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    return highlight(snippet, terms);
  }

  function byId(id) { return document.getElementById(id); }

  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    if (html != null) e.innerHTML = html;
    return e;
  }

  var FIT_LABEL = { green: "Great fit", amber: "Good fit", red: "Consider carefully", na: "Not a decision" };
  var FIT_ICON = { green: "🟢", amber: "🟡", red: "🔴", na: "—" };
  var FIT_PILL = { green: "pill-green", amber: "pill-amber", red: "pill-red", na: "pill-slate" };

  /* ------------------------------------------------------------------ */
  /* Search index — built once over every field of STACK                */
  /* ------------------------------------------------------------------ */

  var _index = null;

  function sectionMeta(id) {
    return STACK.sections.filter(function (s) { return s.id === id; })[0] || null;
  }

  function buildIndex() {
    if (_index) return _index;
    var idx = [];
    function push(sectionId, title, text) {
      var sec = sectionMeta(sectionId);
      if (!sec) return;
      idx.push({ sectionId: sectionId, file: sec.file, sectionTitle: sec.shortTitle, title: title, text: text });
    }

    STACK.fitKey.forEach(function (f) { push("summary", f.label, f.desc); });
    push("summary", "Headline", STACK.headline);

    STACK.recommendations.forEach(function (r) {
      var bits = [r.technology, "Category: " + r.category, r.why];
      if (r.caveat) bits.push("Caveat: " + r.caveat);
      if (r.alternative) bits.push("Alternative: " + r.alternative.name + " — " + r.alternative.why);
      push("recommendations", r.component, bits.join(". "));
    });

    STACK.recommendations.forEach(function (r) {
      push("prompts", r.component + " — " + r.technology, r.learnPrompt);
    });

    STACK.learningOrder.forEach(function (l) {
      push("learnorder", "Step " + l.n + ": " + l.technology, l.why);
    });

    STACK.recommendations.forEach(function (r) {
      if (r.alternative) push("alternatives", r.component + " vs " + r.alternative.name, r.alternative.why);
    });

    STACK.recommendations.forEach(function (r) {
      push("lockin", r.component + " (" + r.lockIn + ")", r.lockInWhy || "");
    });

    STACK.notCovered.forEach(function (n) { push("notcovered", n.item, n.why); });
    STACK.leastConfident.forEach(function (l) { push("notcovered", "Least confident: " + l.component, l.why); });

    STACK.recommendations.forEach(function (r) {
      push("appendix", r.component, r.technology + " — " + FIT_LABEL[r.fit]);
    });
    STACK.notApplicable.forEach(function (n) { push("appendix", n.component, n.note); });

    _index = idx;
    return idx;
  }

  function scoreEntry(entry, terms, rawQuery) {
    var titleStems = tokenize(entry.title).map(stem);
    var textStems = tokenize(entry.text).map(stem);
    var score = 0;
    terms.forEach(function (t) {
      var s = stem(t);
      titleStems.forEach(function (ts) { if (ts === s) score += 5; });
      textStems.forEach(function (ts) { if (ts === s) score += 1; });
    });
    var q = rawQuery.toLowerCase().trim();
    if (q.length > 2) {
      if (entry.title.toLowerCase().indexOf(q) >= 0) score += 8;
      else if (entry.text.toLowerCase().indexOf(q) >= 0) score += 4;
    }
    return score;
  }

  function search(query, opts) {
    opts = opts || {};
    var idx = buildIndex();
    var terms = tokenize(query);
    if (!terms.length) return [];
    var scored = idx.map(function (e) { return { entry: e, score: scoreEntry(e, terms, query) }; })
      .filter(function (x) { return x.score > 0; });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, opts.limit || 20);
  }

  /* ------------------------------------------------------------------ */
  /* Theme, print, scroll progress, back-to-top                        */
  /* ------------------------------------------------------------------ */

  function currentTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }

  function initTheme(btn) {
    var saved = null;
    try { saved = localStorage.getItem("stack-theme"); } catch (e) {}
    if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved);
    function paint() { btn.textContent = currentTheme() === "dark" ? "Light" : "Dark"; }
    paint();
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("stack-theme", next); } catch (e) {}
      paint();
      _reRenderJobs.forEach(function (fn) { fn(); });
    });
  }

  function initScrollProgress() {
    var bar = el("div", { id: "scroll-progress" });
    document.body.appendChild(bar);
    function paint() {
      var h = document.documentElement;
      var scrollTop = h.scrollTop || document.body.scrollTop;
      var height = (h.scrollHeight || document.body.scrollHeight) - h.clientHeight;
      var pct = height > 0 ? (scrollTop / height) * 100 : 0;
      bar.style.width = pct + "%";
    }
    document.addEventListener("scroll", paint, { passive: true });
    paint();
  }

  function initBackToTop() {
    var btn = el("button", { id: "back-to-top", type: "button", "aria-label": "Back to top" }, "↑");
    document.body.appendChild(btn);
    btn.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    document.addEventListener("scroll", function () {
      btn.classList.toggle("show", (window.scrollY || document.documentElement.scrollTop) > 480);
    }, { passive: true });
  }

  /* ------------------------------------------------------------------ */
  /* Top navigation, breadcrumbs, foot nav                              */
  /* ------------------------------------------------------------------ */

  function renderTopNav(pageId) {
    var nav = el("header", { class: "topnav" });
    var isIndex = pageId === "index";
    nav.innerHTML =
      '<div class="topnav-inner">' +
        '<a class="brand" href="index.html"><span class="brand-badge">TS</span><span>' + escapeHtml(STACK.meta.title) + '</span></a>' +
        (isIndex ? "" : '<a class="cc-link" href="index.html">← Command Center</a>') +
        '<a class="bp-link" href="' + escapeHtml(STACK.meta.sourceFile) + '">Architecture ↗</a>' +
        '<div class="topnav-spacer"></div>' +
        '<div class="search-box">' +
          '<span class="search-icon">⌕</span>' +
          '<input type="text" id="nav-search-input" placeholder="Search the stack…" autocomplete="off" aria-label="Search the stack">' +
          '<div class="search-results" id="nav-search-results"></div>' +
        '</div>' +
        '<button class="icon-btn label-btn" id="theme-toggle-btn" type="button" title="Toggle theme">Dark</button>' +
        '<button class="icon-btn label-btn" id="print-btn" type="button" title="Print this page">Print</button>' +
      '</div>';
    document.body.insertBefore(nav, document.body.firstChild);

    initTheme(byId("theme-toggle-btn"));
    byId("print-btn").addEventListener("click", function () { window.print(); });

    var input = byId("nav-search-input");
    var results = byId("nav-search-results");

    function renderDropdown(q) {
      if (!q || q.trim().length < 2) { results.classList.remove("open"); results.innerHTML = ""; return; }
      var terms = tokenize(q);
      var hits = search(q, { limit: 12 });
      if (!hits.length) {
        results.innerHTML = '<div class="search-empty">No matches for “' + escapeHtml(q) + '”. Check <a href="07-not-covered.html">What This Doesn’t Tell You</a> — a miss may itself be the answer.</div>';
        results.classList.add("open");
        return;
      }
      results.innerHTML = hits.map(function (h) {
        var title = highlight(h.entry.title, terms);
        var snippet = makeSnippet(h.entry.text, terms);
        return '<a class="search-result" href="' + h.entry.file + '">' +
          '<div class="search-result-section">' + escapeHtml(h.entry.sectionTitle) + '</div>' +
          '<div class="search-result-title">' + title + '</div>' +
          '<div class="search-result-snippet">' + snippet + '</div>' +
          '</a>';
      }).join("");
      results.classList.add("open");
    }

    input.addEventListener("input", function () {
      renderDropdown(input.value);
      applyOnPageNarrowing(input.value);
    });
    input.addEventListener("focus", function () { if (input.value.trim().length >= 2) renderDropdown(input.value); });
    document.addEventListener("click", function (e) {
      if (!results.contains(e.target) && e.target !== input) results.classList.remove("open");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") results.classList.remove("open");
      if ((e.key === "/" || (e.ctrlKey && e.key === "k")) && document.activeElement !== input) {
        var tag = (document.activeElement && document.activeElement.tagName) || "";
        if (tag !== "INPUT" && tag !== "TEXTAREA") { e.preventDefault(); input.focus(); }
      }
    });
  }

  var _searchableEls = [];
  function registerSearchable(selector) {
    document.querySelectorAll(selector).forEach(function (e) { _searchableEls.push(e); });
  }
  function applyOnPageNarrowing(query) {
    var q = (query || "").trim().toLowerCase();
    if (q.length < 2) { _searchableEls.forEach(function (e) { e.style.display = ""; }); return; }
    var terms = tokenize(q);
    _searchableEls.forEach(function (e) {
      var text = e.textContent.toLowerCase();
      var match = text.indexOf(q) >= 0 || (terms.length && terms.every(function (t) { return text.indexOf(t) >= 0; }));
      e.style.display = match ? "" : "none";
    });
  }

  function renderBreadcrumbs(pageId) {
    var slot = byId("breadcrumbs-slot");
    if (!slot) return;
    var sec = sectionMeta(pageId);
    slot.innerHTML =
      '<nav class="breadcrumbs" aria-label="Breadcrumb">' +
        '<a href="index.html">Command Center</a>' +
        '<span class="sep">/</span>' +
        '<span class="current">' + escapeHtml(sec ? sec.title : "") + '</span>' +
      '</nav>';
  }

  function renderFootNav(pageId) {
    var slot = byId("foot-nav-slot");
    if (!slot) return;
    var sections = STACK.sections;
    var idx = sections.findIndex(function (s) { return s.id === pageId; });
    var prev = idx <= 0 ? { file: "index.html", shortTitle: "Command Center" } : sections[idx - 1];
    var next = idx === -1 || idx === sections.length - 1 ? { file: "index.html", shortTitle: "Command Center" } : sections[idx + 1];
    slot.innerHTML =
      '<div class="foot-nav">' +
        '<a class="prev" href="' + prev.file + '"><div class="dir">← Previous</div><div class="lbl">' + escapeHtml(prev.shortTitle) + '</div></a>' +
        '<a class="next" href="' + next.file + '"><div class="dir">Next →</div><div class="lbl">' + escapeHtml(next.shortTitle) + '</div></a>' +
      '</div>';
  }

  function renderFooter() {
    var f = el("footer", { class: "site-footer" }, '<div class="wrap">' + escapeHtml(STACK.meta.generatedNote) + '</div>');
    document.body.appendChild(f);
  }

  /* ------------------------------------------------------------------ */
  /* Copy-to-clipboard                                                   */
  /* ------------------------------------------------------------------ */

  function copyText(text) {
    return new Promise(function (resolve, reject) {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(resolve).catch(function () { fallbackCopy(text, resolve, reject); });
      } else {
        fallbackCopy(text, resolve, reject);
      }
    });
  }
  function fallbackCopy(text, resolve, reject) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error("execCommand failed"));
    } catch (e) { reject(e); }
  }

  function renderCopyRow(promptText) {
    var rowId = "copy-" + Math.random().toString(36).slice(2, 9);
    return '<div class="copy-row">' +
      '<div class="prompt-text">“' + escapeHtml(promptText) + '”</div>' +
      '<button class="copy-btn" type="button" data-copy-target="' + rowId + '">Copy</button>' +
      '<span class="visually-hidden" id="' + rowId + '">' + escapeHtml(promptText) + '</span>' +
      '</div>';
  }

  function wireCopyButtons(root) {
    (root || document).querySelectorAll(".copy-btn").forEach(function (btn) {
      if (btn._wired) return;
      btn._wired = true;
      btn.addEventListener("click", function () {
        var targetId = btn.getAttribute("data-copy-target");
        var text = targetId ? (byId(targetId) ? byId(targetId).textContent : "") : "";
        copyText(text).then(function () {
          var original = btn.textContent;
          btn.textContent = "Copied ✓";
          btn.classList.add("copied");
          setTimeout(function () { btn.textContent = original; btn.classList.remove("copied"); }, 1600);
        }).catch(function () {
          btn.textContent = "Select & copy manually";
        });
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Fullscreen figure viewer (zoom + pan)                              */
  /* ------------------------------------------------------------------ */

  var _viewerState = { zoom: 1, panX: 0, panY: 0, dragging: false };

  function ensureViewer() {
    if (byId("viewer-overlay")) return;
    var overlay = el("div", { id: "viewer-overlay", class: "viewer-overlay" });
    overlay.innerHTML =
      '<div class="viewer-panel">' +
        '<div class="viewer-toolbar">' +
          '<div class="title" id="viewer-title">Figure</div>' +
          '<div class="viewer-controls">' +
            '<button class="icon-btn label-btn" id="viewer-zoom-out" type="button">−</button>' +
            '<button class="icon-btn label-btn" id="viewer-zoom-reset" type="button">Reset</button>' +
            '<button class="icon-btn label-btn" id="viewer-zoom-in" type="button">+</button>' +
            '<button class="icon-btn label-btn" id="viewer-close" type="button">Close ✕</button>' +
          '</div>' +
        '</div>' +
        '<div class="viewer-stage" id="viewer-stage"><div class="viewer-stage-inner" id="viewer-stage-inner"></div></div>' +
      '</div>';
    document.body.appendChild(overlay);

    function paint() {
      byId("viewer-stage-inner").style.transform =
        "translate(" + _viewerState.panX + "px," + _viewerState.panY + "px) scale(" + _viewerState.zoom + ")";
    }
    byId("viewer-zoom-in").addEventListener("click", function () { _viewerState.zoom = Math.min(4, _viewerState.zoom * 1.25); paint(); });
    byId("viewer-zoom-out").addEventListener("click", function () { _viewerState.zoom = Math.max(0.25, _viewerState.zoom / 1.25); paint(); });
    byId("viewer-zoom-reset").addEventListener("click", function () { _viewerState.zoom = 1; _viewerState.panX = 0; _viewerState.panY = 0; paint(); });
    byId("viewer-close").addEventListener("click", closeViewer);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeViewer(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && overlay.classList.contains("open")) closeViewer(); });

    var stage = byId("viewer-stage");
    stage.addEventListener("mousedown", function (e) {
      _viewerState.dragging = true; stage.classList.add("grabbing");
      _viewerState._lastX = e.clientX; _viewerState._lastY = e.clientY;
    });
    window.addEventListener("mousemove", function (e) {
      if (!_viewerState.dragging) return;
      _viewerState.panX += e.clientX - _viewerState._lastX;
      _viewerState.panY += e.clientY - _viewerState._lastY;
      _viewerState._lastX = e.clientX; _viewerState._lastY = e.clientY;
      paint();
    });
    window.addEventListener("mouseup", function () { _viewerState.dragging = false; stage.classList.remove("grabbing"); });
    stage.addEventListener("wheel", function (e) {
      if (!overlay.classList.contains("open")) return;
      e.preventDefault();
      _viewerState.zoom = Math.max(0.25, Math.min(4, _viewerState.zoom * (e.deltaY < 0 ? 1.1 : 0.9)));
      paint();
    }, { passive: false });
  }

  function openViewer(title, svgMarkup) {
    ensureViewer();
    _viewerState.zoom = 1; _viewerState.panX = 0; _viewerState.panY = 0;
    byId("viewer-title").textContent = title;
    var inner = byId("viewer-stage-inner");
    inner.style.transform = "translate(0px,0px) scale(1)";
    inner.innerHTML = svgMarkup;
    byId("viewer-overlay").classList.add("open");
  }
  function closeViewer() { var o = byId("viewer-overlay"); if (o) o.classList.remove("open"); }

  /* ------------------------------------------------------------------ */
  /* Figure mounting                                                     */
  /* ------------------------------------------------------------------ */

  var _reRenderJobs = [];

  function figureShell(containerId, title) {
    var container = byId(containerId);
    if (!container) return null;
    container.classList.add("figure");
    var bodyId = containerId + "-body";
    container.innerHTML =
      '<div class="figure-head">' +
        '<div class="figure-title">' + escapeHtml(title) + '</div>' +
        '<button class="expand-btn" type="button">⤡ Expand</button>' +
      '</div>' +
      '<div class="figure-body" id="' + bodyId + '"></div>';
    return container;
  }

  function appendInterpretation(container, text) {
    if (!text) return;
    container.appendChild(el("div", { class: "figure-interpret" }, escapeHtml(text)));
  }

  function renderStaticFigure(containerId, opts) {
    var container = figureShell(containerId, opts.title);
    if (!container) return;
    var draw = function () {
      var svg = typeof opts.svg === "function" ? opts.svg(false) : opts.svgMarkup;
      byId(containerId + "-body").innerHTML = svg;
    };
    draw();
    if (typeof opts.svg === "function") _reRenderJobs.push(draw);
    appendInterpretation(container, opts.interpretation);
    container.querySelector(".expand-btn").addEventListener("click", function () {
      var svg = typeof opts.svg === "function" ? opts.svg(false) : opts.svgMarkup;
      openViewer(opts.title, svg);
    });
  }

  /* ------------------------------------------------------------------ */
  /* SVG illustrations, generated from STACK                            */
  /* ------------------------------------------------------------------ */

  var FIT_COLOR = { green: "var(--c-green,#15803d)", amber: "var(--c-amber,#b45309)", red: "var(--c-red,#b91c1c)", na: "var(--c-slate,#475569)" };
  var FIT_BG = { green: "var(--c-green-bg,#ecfdf3)", amber: "var(--c-amber-bg,#fffbeb)", red: "var(--c-red-bg,#fef2f2)", na: "var(--c-slate-bg,#f1f5f9)" };

  function svgWrap(viewBox, body) {
    return '<svg viewBox="' + viewBox + '" xmlns="http://www.w3.org/2000/svg" role="img" style="width:100%;height:auto;font-family:Segoe UI, system-ui, sans-serif;">' + body + '</svg>';
  }

  function wrapText(text, maxChars, maxLines, xAnchor, lineHeight) {
    var words = String(text).split(" ");
    var lines = []; var cur = "";
    words.forEach(function (w) {
      if ((cur + " " + w).trim().length > maxChars) { lines.push(cur.trim()); cur = w; }
      else cur = (cur + " " + w).trim();
    });
    if (cur) lines.push(cur.trim());
    lines = lines.slice(0, maxLines || 2);
    var x = xAnchor == null ? 0 : xAnchor;
    var dy = lineHeight || 11;
    return lines.map(function (l, i) { return '<tspan x="' + x + '" dy="' + (i === 0 ? 0 : dy) + '">' + escapeHtml(l) + '</tspan>'; }).join("");
  }

  /* 1. Fit bands — the whole stack as bands, grouped by category, colored by fit */
  function fitBands(compact) {
    var cats = STACK.categories;
    var w = compact ? 400 : 1080;
    var rowH = compact ? 20 : 44;
    var gap = compact ? 4 : 9;
    var h = 10;
    var body = "";
    var y = 8;
    cats.forEach(function (cat) {
      var items = STACK.recommendations.filter(function (r) { return r.category === cat.id; });
      if (!items.length) return;
      body += '<text x="8" y="' + (y + 12) + '" font-size="' + (compact ? 9 : 10.5) + '" fill="var(--muted,#64748b)" font-weight="700" letter-spacing="0.03em">' + escapeHtml(cat.short.toUpperCase()) + '</text>';
      y += compact ? 14 : 18;
      var segW = (w - 16) / items.length;
      items.forEach(function (r, i) {
        var x = 8 + i * segW;
        var color = FIT_COLOR[r.fit], bg = FIT_BG[r.fit];
        body += '<rect x="' + x + '" y="' + y + '" width="' + (segW - 3) + '" height="' + rowH + '" rx="6" fill="' + bg + '" stroke="' + color + '" stroke-width="1.2"/>';
        if (!compact) {
          var cxLabel = x + (segW - 3) / 2;
          var labelLines = wrapText(r.technology.split("(")[0].trim(), Math.max(8, segW / 6.5), 2, cxLabel, 11);
          var startY = rowH > 34 ? y + rowH / 2 - 3 : y + rowH / 2 + 3.5;
          body += '<text x="' + cxLabel + '" y="' + startY + '" font-size="8.6" text-anchor="middle" fill="' + color + '" font-weight="700">' + labelLines + '</text>';
        }
      });
      y += rowH + gap;
    });
    h = y + 6;
    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 2. Proportional bar of green/amber/red, reds called out */
  function proportionalBar(compact) {
    var counts = { green: 0, amber: 0, red: 0 };
    STACK.recommendations.forEach(function (r) { counts[r.fit] = (counts[r.fit] || 0) + 1; });
    var total = counts.green + counts.amber + counts.red;
    var w = compact ? 400 : 1000;
    var barH = compact ? 26 : 54;
    var barY = compact ? 10 : 20;
    var order = ["green", "amber", "red"];
    var body = "";
    var x = 0;
    order.forEach(function (k) {
      var segW = (counts[k] / total) * w;
      body += '<rect x="' + x + '" y="' + barY + '" width="' + segW + '" height="' + barH + '" fill="' + FIT_COLOR[k] + '"/>';
      if (!compact && segW > 30) {
        body += '<text x="' + (x + segW / 2) + '" y="' + (barY + barH / 2 + 4) + '" font-size="12" text-anchor="middle" fill="#fff" font-weight="800">' + counts[k] + '</text>';
      }
      x += segW;
    });
    var h = barY + barH + (compact ? 24 : 46);
    var legendY = barY + barH + (compact ? 16 : 28);
    var lx = 0;
    if (!compact) {
      [["green", "Great fit"], ["amber", "Good fit"], ["red", "Consider carefully"]].forEach(function (pair) {
        body += '<circle cx="' + (lx + 6) + '" cy="' + legendY + '" r="5" fill="' + FIT_COLOR[pair[0]] + '"/>';
        body += '<text x="' + (lx + 16) + '" y="' + (legendY + 4) + '" font-size="10" fill="var(--text,#0f172a)">' + pair[1] + ' (' + counts[pair[0]] + ')</text>';
        lx += pair[0] === "red" ? 0 : (compact ? 90 : 170);
      });
    } else {
      body += '<text x="' + (w / 2) + '" y="' + legendY + '" font-size="9" text-anchor="middle" fill="var(--muted,#64748b)">' + total + ' rated — ' + counts.red + ' to watch</text>';
    }
    if (counts.red > 0) {
      var redX = w - (counts.red / total) * w;
      body += '<line x1="' + (redX + (counts.red / total) * w / 2) + '" y1="' + (barY - 4) + '" x2="' + (redX + (counts.red / total) * w / 2) + '" y2="' + (barY - (compact?10:16)) + '" stroke="' + FIT_COLOR.red + '" stroke-width="1.4"/>';
      if (!compact) body += '<text x="' + (redX + (counts.red / total) * w / 2) + '" y="' + (barY - 20) + '" font-size="9.5" text-anchor="middle" fill="' + FIT_COLOR.red + '" font-weight="800">WATCH THIS ONE</text>';
    }
    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 3. Topology — what runs on your infra vs a vendor's */
  function topology(compact) {
    var yours = STACK.recommendations.filter(function (r) { return r.runsOn === "yours"; });
    var vendor = STACK.recommendations.filter(function (r) { return r.runsOn === "vendor"; });
    var w = compact ? 400 : 1000;
    var h = compact ? 150 : 300;
    var colW = w / 2 - 10;
    var body = "";
    var defs = '<defs><clipPath id="tclip"><rect x="0" y="0" width="' + w + '" height="' + h + '"/></clipPath></defs>';
    body += '<rect x="0" y="0" width="' + colW + '" height="' + h + '" rx="10" fill="var(--c-teal-bg,#f0fdfa)" stroke="var(--c-teal,#0f766e)" stroke-width="1.2"/>';
    body += '<rect x="' + (w - colW) + '" y="0" width="' + colW + '" height="' + h + '" rx="10" fill="var(--c-amber-bg,#fffbeb)" stroke="var(--c-amber,#b45309)" stroke-width="1.2"/>';
    body += '<text x="' + (colW / 2) + '" y="' + (compact ? 16 : 24) + '" font-size="' + (compact ? 9.5 : 12) + '" text-anchor="middle" fill="var(--c-teal,#0f766e)" font-weight="800">YOUR INFRASTRUCTURE</text>';
    body += '<text x="' + (w - colW / 2) + '" y="' + (compact ? 16 : 24) + '" font-size="' + (compact ? 9.5 : 12) + '" text-anchor="middle" fill="var(--c-amber,#b45309)" font-weight="800">A VENDOR RUNS THIS</text>';

    function chip(items, colX, colWidth, color, bg) {
      var chipH = compact ? 14 : 22;
      var chipGap = compact ? 3 : 6;
      var cy = compact ? 26 : 42;
      var cx = colX + 8;
      items.forEach(function (r) {
        var label = compact ? r.technology.split("(")[0].trim().slice(0, 10) : r.technology.split("(")[0].trim();
        var chipW = compact ? Math.min(colWidth - 16, label.length * 5 + 10) : Math.min(colWidth - 16, label.length * 6.4 + 16);
        if (cx + chipW > colX + colWidth - 6) { cx = colX + 8; cy += chipH + chipGap; }
        if (cy + chipH > h - 6) return;
        body += '<rect x="' + cx + '" y="' + cy + '" width="' + chipW + '" height="' + chipH + '" rx="' + (chipH/2) + '" fill="' + bg + '" opacity="0.9" stroke="' + color + '" stroke-width="0.8"/>';
        body += '<text x="' + (cx + chipW / 2) + '" y="' + (cy + chipH / 2 + 3) + '" font-size="' + (compact ? 6.6 : 9) + '" text-anchor="middle" fill="' + color + '" font-weight="600">' + escapeHtml(label) + '</text>';
        cx += chipW + chipGap;
      });
    }
    chip(yours, 0, colW, "var(--c-teal,#0f766e)", "var(--card,#fff)");
    chip(vendor, w - colW, colW, "var(--c-amber,#b45309)", "var(--card,#fff)");

    return svgWrap("0 0 " + w + " " + h, defs + body);
  }

  /* 4. Learning ladder */
  function learningLadder(compact) {
    var steps = STACK.learningOrder;
    var w = compact ? 400 : 720;
    var rowH = compact ? 16 : 34;
    var gap = compact ? 2 : 6;
    var h = 10 + steps.length * (rowH + gap);
    var body = "";
    steps.forEach(function (s, i) {
      var y = 8 + i * (rowH + gap);
      var indent = i * (compact ? 3 : 8);
      var stepW = w - indent - 10;
      body += '<rect x="' + indent + '" y="' + y + '" width="' + stepW + '" height="' + rowH + '" rx="6" fill="var(--c-teal-bg,#f0fdfa)" stroke="var(--c-teal,#0f766e)" stroke-width="1"/>';
      body += '<circle cx="' + (indent + 15) + '" cy="' + (y + rowH / 2) + '" r="' + (compact ? 7 : 11) + '" fill="var(--c-teal,#0f766e)"/>';
      body += '<text x="' + (indent + 15) + '" y="' + (y + rowH / 2 + 3.5) + '" font-size="' + (compact ? 7.5 : 10) + '" text-anchor="middle" fill="#fff" font-weight="800">' + s.n + '</text>';
      if (!compact) body += '<text x="' + (indent + 32) + '" y="' + (y + rowH / 2 + 4) + '" font-size="10.5" fill="var(--text,#0f172a)" font-weight="600">' + escapeHtml(s.technology) + '</text>';
    });
    if (compact) body += '<text x="' + (w/2) + '" y="' + (h - 2) + '" font-size="8.5" text-anchor="middle" fill="var(--muted,#64748b)">' + steps.length + '-step ladder</text>';
    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 5. Lock-in scale */
  function lockInScale(compact) {
    var levels = STACK.lockInLevels;
    var w = compact ? 400 : 1000;
    var laneH = compact ? 34 : 90;
    var h = 20 + levels.length * (laneH + 10);
    var colColor = { easy: "var(--c-green,#15803d)", moderate: "var(--c-amber,#b45309)", hard: "var(--c-red,#b91c1c)" };
    var colBg = { easy: "var(--c-green-bg,#ecfdf3)", moderate: "var(--c-amber-bg,#fffbeb)", hard: "var(--c-red-bg,#fef2f2)" };
    var body = "";
    var y = 10;
    levels.forEach(function (lvl) {
      var items = STACK.recommendations.filter(function (r) { return r.lockIn === lvl.id; });
      body += '<rect x="8" y="' + y + '" width="' + (w - 16) + '" height="' + laneH + '" rx="8" fill="' + colBg[lvl.id] + '" stroke="' + colColor[lvl.id] + '" stroke-width="1.2"/>';
      body += '<text x="18" y="' + (y + 16) + '" font-size="' + (compact ? 8.5 : 11) + '" fill="' + colColor[lvl.id] + '" font-weight="800">' + escapeHtml(lvl.label.toUpperCase()) + ' (' + items.length + ')</text>';
      if (!compact) {
        var cx = 18, cy = y + 34;
        items.forEach(function (r) {
          var label = r.technology.split("(")[0].trim();
          var chipW = Math.min(w - 40, label.length * 6.2 + 16);
          if (cx + chipW > w - 20) { cx = 18; cy += 24; }
          if (cy > y + laneH - 10) return;
          body += '<rect x="' + cx + '" y="' + (cy - 14) + '" width="' + chipW + '" height="18" rx="9" fill="var(--card,#fff)" stroke="' + colColor[lvl.id] + '" stroke-width="0.8"/>';
          body += '<text x="' + (cx + chipW / 2) + '" y="' + (cy - 2) + '" font-size="8.6" text-anchor="middle" fill="' + colColor[lvl.id] + '" font-weight="600">' + escapeHtml(label) + '</text>';
          cx += chipW + 6;
        });
      }
      y += laneH + 10;
    });
    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 6. Recommendations grouped preview (used on the Command Center tile + section 2 header) */
  function groupedOverview(compact) {
    return fitBands(compact);
  }

  var svgGen = {
    summary: proportionalBar,
    recommendations: groupedOverview,
    prompts: null,
    learnorder: learningLadder,
    alternatives: null,
    lockin: lockInScale,
    notcovered: null,
    appendix: topology
  };

  /* ------------------------------------------------------------------ */
  /* Command Center tile grid                                           */
  /* ------------------------------------------------------------------ */

  function renderTileGrid(containerId) {
    var container = byId(containerId);
    if (!container) return;
    var counts = {
      summary: STACK.fitKey.length + " fit levels",
      recommendations: STACK.recommendations.length + " recommendations",
      prompts: STACK.recommendations.length + " prompts",
      learnorder: STACK.learningOrder.length + " steps",
      alternatives: STACK.recommendations.filter(function (r) { return r.alternative; }).length + " alternatives",
      lockin: STACK.lockInLevels.length + " levels",
      notcovered: STACK.notCovered.length + " to watch",
      appendix: (STACK.recommendations.length + STACK.notApplicable.length) + " rows"
    };
    container.innerHTML = STACK.sections.map(function (s) {
      var gen = svgGen[s.id];
      var svg = gen ? gen(true) : simplePreview(s.id);
      return '<a class="tile" href="' + s.file + '">' +
        '<div class="tile-preview">' + svg + '</div>' +
        '<div class="tile-body">' +
          '<div class="tile-title">' + escapeHtml(s.title) + '</div>' +
          '<p class="tile-desc">' + escapeHtml(s.description) + '</p>' +
          '<div class="tile-count">' + escapeHtml(counts[s.id] || "") + '</div>' +
        '</div>' +
      '</a>';
    }).join("");
  }

  function simplePreview(sectionId) {
    var w = 400, h = 130;
    var icon = { prompts: "❝ ❞", alternatives: "⇄", notcovered: "◌" }[sectionId] || "•";
    return svgWrap("0 0 " + w + " " + h, '<text x="' + (w/2) + '" y="' + (h/2+14) + '" font-size="42" text-anchor="middle" fill="var(--accent,#0f766e)" opacity="0.35">' + icon + '</text>');
  }

  /* ------------------------------------------------------------------ */
  /* Ask panel: Search mode (no key) + Claude mode (own API key)        */
  /* ------------------------------------------------------------------ */

  var HAIKU_ID = "claude-haiku-4-5-20251001";

  function sectionSlice(pageId) {
    switch (pageId) {
      case "summary": return { fitKey: STACK.fitKey, headline: STACK.headline };
      case "recommendations": return { categories: STACK.categories, recommendations: STACK.recommendations, notApplicable: STACK.notApplicable };
      case "prompts": return { recommendations: STACK.recommendations.map(function (r) { return { component: r.component, technology: r.technology, learnPrompt: r.learnPrompt }; }) };
      case "learnorder": return { learningOrder: STACK.learningOrder };
      case "alternatives": return { recommendations: STACK.recommendations.map(function (r) { return { component: r.component, technology: r.technology, alternative: r.alternative }; }) };
      case "lockin": return { lockInLevels: STACK.lockInLevels, recommendations: STACK.recommendations.map(function (r) { return { component: r.component, lockIn: r.lockIn, lockInWhy: r.lockInWhy }; }) };
      case "notcovered": return { notCovered: STACK.notCovered, leastConfident: STACK.leastConfident };
      case "appendix": return { recommendations: STACK.recommendations, notApplicable: STACK.notApplicable };
      default: return STACK;
    }
  }

  function buildSystemPrompt(scope, pageId) {
    var data = scope === "section" ? sectionSlice(pageId) : STACK;
    return "You are answering questions about a technology-stack recommendation document for a project called \"" + STACK.meta.title +
      "\". Answer ONLY using the JSON data below. Do not use outside knowledge beyond what is stated in this data. " +
      "Never talk the user out of a 🔴 (red / \"consider carefully\") rating — if asked whether a red-rated choice is fine, restate the caution from the data, don't soften it. " +
      "If the answer is not present in this data, say so plainly and suggest the user try Search mode or check the \"What This Doesn't Tell You\" page. Be concise and specific.\n\n" +
      "STACK_DATA:\n" + JSON.stringify(data, null, 2);
  }

  function initAsk(pageId) {
    var root = document.body;
    var panel = el("div", { class: "ask-panel" });
    panel.innerHTML = '<button class="ask-fab" id="ask-fab" type="button" aria-label="Ask about this tech stack">?</button>';
    root.appendChild(panel);

    var win = el("div", { class: "ask-window", id: "ask-window" });
    win.innerHTML =
      '<div class="ask-header">' +
        '<div class="ask-title"><span>Ask about the stack</span><button class="icon-btn label-btn" id="ask-close" type="button">Close</button></div>' +
        '<div class="ask-modes">' +
          '<button class="ask-mode-btn active" id="ask-mode-search" type="button">Search — no key</button>' +
          '<button class="ask-mode-btn" id="ask-mode-claude" type="button">Claude — needs key</button>' +
        '</div>' +
        '<div class="ask-scope-row" id="ask-claude-config" style="display:none;">' +
          '<label>Scope: <select id="ask-scope"><option value="section">This section</option><option value="whole">Whole stack</option></select></label>' +
          '<label>Model: <select id="ask-model">' +
            '<option value="claude-opus-5" selected>Claude Opus 5</option>' +
            '<option value="claude-sonnet-5">Claude Sonnet 5</option>' +
            '<option value="' + HAIKU_ID + '">Claude Haiku 4.5</option>' +
          '</select></label>' +
        '</div>' +
        '<div class="ask-scope-row" id="ask-key-row" style="display:none;">' +
          '<input type="password" id="ask-api-key" placeholder="sk-ant-… (your Anthropic API key)" style="flex:1;">' +
        '</div>' +
        '<div class="ask-key-note" id="ask-key-note" style="display:none;">Stored only in this browser’s localStorage. Never sent anywhere except api.anthropic.com.</div>' +
      '</div>' +
      '<div class="ask-body" id="ask-body"><div class="ask-hint">Ask a question about the tech stack. Search mode works fully offline, right now.</div></div>' +
      '<div class="ask-footer">' +
        '<input type="text" id="ask-input" placeholder="e.g. why not Blazor?">' +
        '<button id="ask-submit" type="button">Ask</button>' +
      '</div>';
    root.appendChild(win);

    var fab = byId("ask-fab"), closeBtn = byId("ask-close");
    fab.addEventListener("click", function () { win.classList.toggle("open"); });
    closeBtn.addEventListener("click", function () { win.classList.remove("open"); });

    var mode = "search";
    var modeSearchBtn = byId("ask-mode-search"), modeClaudeBtn = byId("ask-mode-claude");
    var claudeConfig = byId("ask-claude-config"), keyRow = byId("ask-key-row"), keyNote = byId("ask-key-note");

    function setMode(m) {
      mode = m;
      modeSearchBtn.classList.toggle("active", m === "search");
      modeClaudeBtn.classList.toggle("active", m === "claude");
      var show = m === "claude";
      claudeConfig.style.display = show ? "flex" : "none";
      keyRow.style.display = show ? "flex" : "none";
      keyNote.style.display = show ? "block" : "none";
    }
    modeSearchBtn.addEventListener("click", function () { setMode("search"); });
    modeClaudeBtn.addEventListener("click", function () { setMode("claude"); });

    var keyInput = byId("ask-api-key");
    try {
      var savedKey = localStorage.getItem("stack-anthropic-key");
      if (savedKey) keyInput.value = savedKey;
    } catch (e) {}
    keyInput.addEventListener("change", function () {
      try { localStorage.setItem("stack-anthropic-key", keyInput.value); } catch (e) {}
    });
    var modelSelect = byId("ask-model");
    try {
      var savedModel = localStorage.getItem("stack-anthropic-model");
      if (savedModel) modelSelect.value = savedModel;
    } catch (e) {}
    modelSelect.addEventListener("change", function () {
      try { localStorage.setItem("stack-anthropic-model", modelSelect.value); } catch (e) {}
    });

    var body = byId("ask-body");
    var input = byId("ask-input");
    var submit = byId("ask-submit");

    function runSearch(query) {
      var terms = tokenize(query);
      var hits = search(query, { limit: 8 });
      if (!hits.length) {
        body.innerHTML = '<div class="ask-hint">No matches for “' + escapeHtml(query) + '”. That gap may itself be the answer — check <a href="07-not-covered.html">What This Doesn’t Tell You</a>.</div>';
        return;
      }
      body.innerHTML = hits.map(function (h) {
        return '<a class="ask-card" href="' + h.entry.file + '">' +
          '<div class="sec">' + escapeHtml(h.entry.sectionTitle) + '</div>' +
          '<div class="snip"><strong>' + highlight(h.entry.title, terms) + '</strong><br>' + makeSnippet(h.entry.text, terms) + '</div>' +
        '</a>';
      }).join("");
    }

    function fallbackNote(msg) {
      return '<div class="ask-error">' + escapeHtml(msg) + ' You can switch to <strong>Search — no key</strong> mode above — it works fully offline.</div>';
    }

    function runClaude(query) {
      var key = keyInput.value.trim();
      if (!key) { body.innerHTML = fallbackNote("Paste your Anthropic API key above first."); return; }
      var scope = byId("ask-scope").value;
      var model = modelSelect.value;
      body.innerHTML = '<div class="ask-hint">Asking Claude…</div>';
      var reqBody = {
        model: model,
        max_tokens: 16000,
        system: buildSystemPrompt(scope, pageId),
        messages: [{ role: "user", content: query }]
      };
      if (model !== HAIKU_ID) reqBody.output_config = { effort: "low" };

      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify(reqBody)
      }).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (errJson) {
            var msg = (errJson && errJson.error && errJson.error.message) || ("HTTP " + res.status);
            if (res.status === 401) msg = "Invalid API key.";
            else if (res.status === 429) msg = "Rate limited by the Anthropic API — try again shortly.";
            throw new Error(msg);
          });
        }
        return res.json();
      }).then(function (data) {
        if (data.stop_reason === "refusal") {
          body.innerHTML = fallbackNote("Claude declined to answer this request.");
          return;
        }
        var text = (data.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n\n");
        body.innerHTML = '<div class="ask-answer">' + escapeHtml(text || "(empty response)") + '</div>';
      }).catch(function (err) {
        body.innerHTML = fallbackNote("Couldn’t reach Claude: " + (err && err.message ? err.message : "network error") + ".");
      });
    }

    function ask() {
      var q = input.value.trim();
      if (!q) return;
      if (mode === "search") runSearch(q);
      else runClaude(q);
    }
    submit.addEventListener("click", ask);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") ask(); });
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  function init(opts) {
    var pageId = opts.page;
    renderTopNav(pageId);
    initScrollProgress();
    initBackToTop();
    renderBreadcrumbs(pageId);
    renderFootNav(pageId);
    renderFooter();
    initAsk(pageId);
    if (pageId === "index") renderTileGrid("tile-grid");
    document.addEventListener("click", function (e) {
      if (e.target && e.target.classList && e.target.classList.contains("copy-btn")) return;
    });
    setTimeout(function () { wireCopyButtons(document); }, 0);
  }

  return {
    init: init,
    search: search,
    tokenize: tokenize,
    highlight: highlight,
    escapeHtml: escapeHtml,
    registerSearchable: registerSearchable,
    renderStaticFigure: renderStaticFigure,
    renderCopyRow: renderCopyRow,
    wireCopyButtons: wireCopyButtons,
    fitIcon: function (fit) { return FIT_ICON[fit]; },
    fitLabel: function (fit) { return FIT_LABEL[fit]; },
    fitPillClass: function (fit) { return FIT_PILL[fit]; },
    svg: {
      fitBands: fitBands,
      proportionalBar: proportionalBar,
      topology: topology,
      learningLadder: learningLadder,
      lockInScale: lockInScale
    }
  };
})();
