/*
  Shared rendering, navigation, search, and Ask-agent logic for every page
  in this knowledge base. Loaded after assets/mvp.js via a classic
  <script> tag — references the bare `MVP` identifier, never `window.MVP`.
  No ES modules, no fetch() of local files, no CDN: this all has to work
  opened straight from disk over file://.
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

  var TONE_PILL = { green: "pill-green", amber: "pill-amber", red: "pill-red", teal: "pill-teal", slate: "pill-slate", info: "pill-info" };

  /* ------------------------------------------------------------------ */
  /* Search index — built once over every field of MVP                  */
  /* ------------------------------------------------------------------ */

  var _index = null;

  function sectionMeta(id) {
    return MVP.sections.filter(function (s) { return s.id === id; })[0] || null;
  }

  function buildIndex() {
    if (_index) return _index;
    var idx = [];
    function push(sectionId, title, text) {
      var sec = sectionMeta(sectionId);
      if (!sec) return;
      idx.push({ sectionId: sectionId, file: sec.file, sectionTitle: sec.shortTitle, title: title, text: text });
    }

    /* 1 — The Bet */
    push("bet", "The one question Week 1 answers", MVP.question);
    MVP.building.forEach(function (b) {
      push("bet", b.component, "Being built in Week 1. " + b.description);
    });

    /* 2 — Five days */
    MVP.fiveDays.forEach(function (d) {
      push("fivedays", d.day, d.short + ". " + d.outcome);
    });

    /* 3 — What's cut */
    MVP.cuts.forEach(function (c) {
      push("cuts", "Cut: " + c.cut, "What it would prove: " + c.proves + " Why that isn't this week's question: " + c.whyNot);
    });
    MVP.stackCutdown.forEach(function (s) {
      push("cuts", s.component + " — cut down to Week 1", "Full recommendation: " + s.full + ". Week 1: " + s.week1);
    });

    /* 4 — The mockup */
    push("mockup", "The mockup screen", MVP.mockup.intro + " " + MVP.mockup.regions.map(function (r) { return r.label + ": " + r.detail; }).join(" "));
    MVP.mockup.notes.forEach(function (n, i) {
      push("mockup", "Worth noticing #" + (i + 1), n);
    });

    /* 5 — The pitch */
    push("pitch", MVP.pitch.headline, MVP.pitch.subhead);
    push("pitch", "Who needs it", MVP.pitch.who);
    push("pitch", "Why it matters", MVP.pitch.why);
    MVP.pitch.bullets.forEach(function (b) {
      push("pitch", b.claim, "(" + b.label + ") " + b.detail);
    });
    push("pitch", "What's next", MVP.pitch.whatsNext);

    /* 6 — Did it work? */
    push("outcome", "What “it worked” looks like", MVP.successBar);
    push("outcome", "What “it didn't work” looks like", MVP.failureBar);
    MVP.outcomes.forEach(function (o) {
      push("outcome", o.outcome + " — " + o.nextMoveShort, "What happened: " + o.whatHappened + " Next move: " + o.nextMove);
    });

    /* 7 — Appendix */
    MVP.provesNothing.forEach(function (p, i) {
      push("appendix", "Proves nothing about #" + (i + 1), p);
    });
    MVP.groundedIn.forEach(function (g) {
      push("appendix", "Grounded in: " + g.label, g.fileLabel + " — " + g.detail);
    });

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
    try { saved = localStorage.getItem("mvp-theme"); } catch (e) {}
    if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved);
    function paint() { btn.textContent = currentTheme() === "dark" ? "Light" : "Dark"; }
    paint();
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("mvp-theme", next); } catch (e) {}
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
        '<a class="brand" href="index.html"><span class="brand-badge">W1</span><span>' + escapeHtml(MVP.meta.title) + '</span></a>' +
        (isIndex ? "" : '<a class="cc-link" href="index.html">← Command Center</a>') +
        '<a class="bp-link" href="' + escapeHtml(MVP.meta.sourceFile) + '">' + escapeHtml(MVP.meta.sourceLabel) + '</a>' +
        '<div class="topnav-spacer"></div>' +
        '<div class="search-box">' +
          '<span class="search-icon">⌕</span>' +
          '<input type="text" id="nav-search-input" placeholder="Search the plan…" autocomplete="off" aria-label="Search the plan">' +
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
        results.innerHTML = '<div class="search-empty">No matches for “' + escapeHtml(q) + '”. Check <a href="07-appendix.html">the Appendix</a> — what Week 1 deliberately proves nothing about may itself be the answer.</div>';
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
    var sections = MVP.sections;
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
    var f = el("footer", { class: "site-footer" }, '<div class="wrap">' + escapeHtml(MVP.meta.generatedNote) + '</div>');
    document.body.appendChild(f);
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
  /* SVG illustrations, generated from MVP                              */
  /* ------------------------------------------------------------------ */

  var C = {
    teal: "var(--c-teal,#0f766e)", tealBg: "var(--c-teal-bg,#f0fdfa)",
    green: "var(--c-green,#15803d)", greenBg: "var(--c-green-bg,#ecfdf3)",
    amber: "var(--c-amber,#b45309)", amberBg: "var(--c-amber-bg,#fffbeb)",
    red: "var(--c-red,#b91c1c)", redBg: "var(--c-red-bg,#fef2f2)",
    slate: "var(--c-slate,#475569)", slateBg: "var(--c-slate-bg,#f1f5f9)",
    info: "var(--c-info,#0369a1)", infoBg: "var(--c-info-bg,#f0f9ff)",
    text: "var(--text,#0f172a)", muted: "var(--muted,#64748b)",
    card: "var(--card,#ffffff)", border: "var(--border,#e2e8f0)"
  };

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

  function arrowDefs(id, color) {
    return '<defs><marker id="' + id + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
      '<path d="M 0 0 L 10 5 L 0 10 z" fill="' + color + '"/></marker></defs>';
  }

  function personGlyph(cx, cy, scale, color) {
    var s = scale || 1;
    return '<circle cx="' + cx + '" cy="' + (cy - 6 * s) + '" r="' + (4.4 * s) + '" fill="' + color + '"/>' +
      '<path d="M ' + (cx - 7.5 * s) + ' ' + (cy + 7 * s) + ' a ' + (7.5 * s) + ' ' + (8 * s) + ' 0 0 1 ' + (15 * s) + ' 0 z" fill="' + color + '"/>';
  }

  /* 1. Inputs → one screen → one verdict (section 1) */
  function inputsToVerdict(compact) {
    var w = compact ? 400 : 1040;
    var h = compact ? 130 : 250;
    var body = arrowDefs("arrow-v", C.teal);

    var steps = [
      { title: "Hardcoded telemetry", sub: "3 events, one pre-grouped incident row", color: C.slate, bg: C.slateBg },
      { title: "Two Claude calls", sub: "Sonnet 5 root cause → Haiku 4.5 summaries", color: C.teal, bg: C.tealBg },
      { title: "One screen", sub: "Events, root cause, both summaries together", color: C.info, bg: C.infoBg }
    ];

    var pad = compact ? 8 : 24;
    var gap = compact ? 16 : 54;
    var endW = compact ? 84 : 220;
    var usable = w - pad * 2 - endW - gap * 3;
    var boxW = usable / 3;
    var boxH = compact ? 52 : 108;
    var boxY = compact ? 34 : 66;

    steps.forEach(function (s, i) {
      var x = pad + i * (boxW + gap);
      body += '<rect x="' + x + '" y="' + boxY + '" width="' + boxW + '" height="' + boxH + '" rx="10" fill="' + s.bg + '" stroke="' + s.color + '" stroke-width="1.4"/>';
      body += '<text x="' + (x + 12) + '" y="' + (boxY + (compact ? 16 : 26)) + '" font-size="' + (compact ? 8 : 13) + '" fill="' + s.color + '" font-weight="800">' + wrapText(s.title, compact ? 16 : 26, 1, x + 12, 12) + '</text>';
      if (!compact) {
        body += '<text x="' + (x + 12) + '" y="' + (boxY + 50) + '" font-size="11" fill="' + C.muted + '">' + wrapText(s.sub, 30, 3, x + 12, 14) + '</text>';
      }
      var ax = x + boxW + 4;
      body += '<line x1="' + ax + '" y1="' + (boxY + boxH / 2) + '" x2="' + (ax + gap - 10) + '" y2="' + (boxY + boxH / 2) + '" stroke="' + C.teal + '" stroke-width="' + (compact ? 1.4 : 2) + '" marker-end="url(#arrow-v)"/>';
    });

    var ex = pad + 3 * (boxW + gap);
    var ecx = ex + endW / 2;
    body += '<rect x="' + ex + '" y="' + (boxY - (compact ? 6 : 10)) + '" width="' + endW + '" height="' + (boxH + (compact ? 12 : 20)) + '" rx="' + (compact ? 14 : 22) + '" fill="' + C.greenBg + '" stroke="' + C.green + '" stroke-width="2"/>';
    body += personGlyph(ecx, boxY + (compact ? 18 : 30), compact ? 0.85 : 1.5, C.green);
    if (!compact) {
      body += '<text x="' + ecx + '" y="' + (boxY + 62) + '" font-size="13.5" text-anchor="middle" fill="' + C.green + '" font-weight="800">HUMAN VERDICT</text>';
      body += '<text x="' + ecx + '" y="' + (boxY + 82) + '" font-size="11" text-anchor="middle" fill="' + C.green + '">' + wrapText("“Would I trust this enough to act on it?”", 30, 2, ecx, 13) + '</text>';
    } else {
      body += '<text x="' + ecx + '" y="' + (boxY + 44) + '" font-size="7.5" text-anchor="middle" fill="' + C.green + '" font-weight="800">VERDICT</text>';
    }

    if (!compact) {
      body += '<text x="' + pad + '" y="26" font-size="12" fill="' + C.muted + '" font-weight="700">EVERYTHING WEEK 1 BUILDS, LEFT TO RIGHT — AND THE ONE THING IT IS FOR</text>';
      body += '<text x="' + pad + '" y="' + (h - 12) + '" font-size="11" fill="' + C.muted + '">No Kafka, no collectors, no MCP gateway, no write path — the three boxes above are the whole build.</text>';
    } else {
      body += '<text x="' + (w / 2) + '" y="18" font-size="9" text-anchor="middle" fill="' + C.muted + '" font-weight="700">INPUTS → ONE SCREEN → ONE VERDICT</text>';
    }

    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 2. The five days as a strip (section 2) */
  function fiveDayStrip(compact) {
    var days = MVP.fiveDays;
    var w = compact ? 400 : 1060;
    var h = compact ? 130 : 230;
    var pad = compact ? 6 : 16;
    var gap = compact ? 5 : 12;
    var segW = (w - pad * 2 - gap * (days.length - 1)) / days.length;
    var segH = compact ? 66 : 124;
    var segY = compact ? 34 : 62;
    var body = arrowDefs("arrow-d", C.teal);

    days.forEach(function (d, i) {
      var isFriday = i === days.length - 1;
      var color = isFriday ? C.green : C.teal;
      var bg = isFriday ? C.greenBg : C.tealBg;
      var x = pad + i * (segW + gap);
      var cx = x + segW / 2;

      body += '<rect x="' + x + '" y="' + segY + '" width="' + segW + '" height="' + segH + '" rx="10" fill="' + bg + '" stroke="' + color + '" stroke-width="' + (isFriday ? 2.2 : 1.3) + '"' + (isFriday ? '' : ' stroke-dasharray="0"') + '/>';

      /* day number badge */
      body += '<circle cx="' + (x + (compact ? 12 : 20)) + '" cy="' + (segY + (compact ? 12 : 20)) + '" r="' + (compact ? 7.5 : 12) + '" fill="' + color + '"/>';
      body += '<text x="' + (x + (compact ? 12 : 20)) + '" y="' + (segY + (compact ? 15 : 24.5)) + '" font-size="' + (compact ? 8 : 12) + '" text-anchor="middle" fill="' + (isFriday ? C.greenBg : C.tealBg) + '" font-weight="800">' + (i + 1) + '</text>';

      body += '<text x="' + (x + (compact ? 24 : 38)) + '" y="' + (segY + (compact ? 15.5 : 25)) + '" font-size="' + (compact ? 8.5 : 13) + '" fill="' + color + '" font-weight="800">' + escapeHtml(compact ? d.day.slice(0, 3) : d.day) + '</text>';

      /* short label — anchored per-segment so nothing overlaps between columns */
      var labelY = segY + (compact ? 34 : 58);
      body += '<text x="' + cx + '" y="' + labelY + '" font-size="' + (compact ? 6.8 : 11) + '" text-anchor="middle" fill="' + C.text + '" font-weight="600">' +
        wrapText(d.short, compact ? 14 : 18, 3, cx, compact ? 9 : 14) + '</text>';

      if (isFriday) {
        body += personGlyph(cx, segY + segH - (compact ? 12 : 22), compact ? 0.75 : 1.25, C.green);
      }

      if (i < days.length - 1) {
        var ax = x + segW + 1;
        body += '<line x1="' + ax + '" y1="' + (segY + segH / 2) + '" x2="' + (ax + gap - 4) + '" y2="' + (segY + segH / 2) + '" stroke="' + C.teal + '" stroke-width="' + (compact ? 1.2 : 1.8) + '" marker-end="url(#arrow-d)"/>';
      }
    });

    if (!compact) {
      body += '<text x="' + pad + '" y="30" font-size="12" fill="' + C.muted + '" font-weight="700">FIVE DAYS, FIVE OUTCOMES — FRIDAY IS THE ONLY ONE THAT NEEDS ANOTHER PERSON</text>';
      body += '<text x="' + pad + '" y="' + (h - 12) + '" font-size="11" fill="' + C.muted + '">Monday–Thursday you can finish alone. Friday you cannot: the verdict belongs to someone who did not build it.</text>';
    } else {
      body += '<text x="' + (w / 2) + '" y="18" font-size="9" text-anchor="middle" fill="' + C.muted + '" font-weight="700">MON → FRI</text>';
    }

    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 3. Kept vs. deleted (section 3) */
  function keptVsCut(compact) {
    var kept = MVP.building;
    var cut = MVP.cuts;
    var w = compact ? 400 : 1000;
    var rowH = compact ? 11 : 26;
    var rowGap = compact ? 2.5 : 6;
    var headY = compact ? 20 : 40;
    var startY = compact ? 28 : 58;
    var tallest = Math.max(kept.length, cut.length);
    var h = startY + tallest * (rowH + rowGap) + (compact ? 12 : 34);
    var colW = w / 2 - (compact ? 10 : 24);
    var leftX = compact ? 4 : 8;
    var rightX = w - colW - (compact ? 4 : 8);
    var body = "";

    body += '<text x="' + (leftX + colW / 2) + '" y="' + headY + '" font-size="' + (compact ? 9 : 13) + '" text-anchor="middle" fill="' + C.green + '" font-weight="800">KEPT — ' + kept.length + '</text>';
    body += '<text x="' + (rightX + colW / 2) + '" y="' + headY + '" font-size="' + (compact ? 9 : 13) + '" text-anchor="middle" fill="' + C.red + '" font-weight="800">CUT — ' + cut.length + '</text>';

    kept.forEach(function (b, i) {
      var y = startY + i * (rowH + rowGap);
      body += '<rect x="' + leftX + '" y="' + y + '" width="' + colW + '" height="' + rowH + '" rx="' + (rowH / 2) + '" fill="' + C.greenBg + '" stroke="' + C.green + '" stroke-width="1.2"/>';
      if (!compact) {
        body += '<text x="' + (leftX + colW / 2) + '" y="' + (y + rowH / 2 + 4) + '" font-size="11" text-anchor="middle" fill="' + C.green + '" font-weight="700">' + escapeHtml(b.short) + '</text>';
      }
    });

    cut.forEach(function (c, i) {
      var y = startY + i * (rowH + rowGap);
      body += '<rect x="' + rightX + '" y="' + y + '" width="' + colW + '" height="' + rowH + '" rx="' + (rowH / 2) + '" fill="' + C.redBg + '" stroke="' + C.red + '" stroke-width="1" stroke-dasharray="4 3" opacity="0.9"/>';
      if (!compact) {
        body += '<text x="' + (rightX + colW / 2) + '" y="' + (y + rowH / 2 + 4) + '" font-size="10.5" text-anchor="middle" fill="' + C.red + '" font-weight="600">' + escapeHtml(c.short) + '</text>';
        body += '<line x1="' + (rightX + 14) + '" y1="' + (y + rowH / 2) + '" x2="' + (rightX + colW - 14) + '" y2="' + (y + rowH / 2) + '" stroke="' + C.red + '" stroke-width="0.7" opacity="0.35"/>';
      }
    });

    var ratio = Math.round((cut.length / (cut.length + kept.length)) * 100);
    if (!compact) {
      body += '<text x="' + (w / 2) + '" y="' + (h - 12) + '" font-size="11.5" text-anchor="middle" fill="' + C.muted + '" font-weight="700">' +
        ratio + '% of the named surface area is deliberately deleted — ' + cut.length + ' cuts against ' + kept.length + ' kept pieces.</text>';
    } else {
      body += '<text x="' + (w / 2) + '" y="' + (h - 3) + '" font-size="8" text-anchor="middle" fill="' + C.muted + '" font-weight="700">' + kept.length + ' kept · ' + cut.length + ' cut</text>';
    }

    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 4. The Friday decision as a three-way fork (section 6) */
  function fridayFork(compact) {
    var outs = MVP.outcomes;
    var w = compact ? 400 : 1020;
    var h = compact ? 140 : 300;
    /* one arrowhead marker per branch so each fork keeps its own semantic color */
    var body = arrowDefs("arrow-f-green", C.green) + arrowDefs("arrow-f-amber", C.amber) + arrowDefs("arrow-f-red", C.red);

    var startX = compact ? 8 : 20;
    var startW = compact ? 96 : 250;
    var startH = compact ? 40 : 78;
    var startY = h / 2 - startH / 2;
    var midX = startX + startW + (compact ? 20 : 60);

    body += '<rect x="' + startX + '" y="' + startY + '" width="' + startW + '" height="' + startH + '" rx="10" fill="' + C.tealBg + '" stroke="' + C.teal + '" stroke-width="1.6"/>';
    if (compact) {
      body += '<text x="' + (startX + startW / 2) + '" y="' + (startY + startH / 2 + 3) + '" font-size="8" text-anchor="middle" fill="' + C.teal + '" font-weight="800">FRIDAY</text>';
    } else {
      body += '<text x="' + (startX + 16) + '" y="' + (startY + 26) + '" font-size="13" fill="' + C.teal + '" font-weight="800">FRIDAY</text>';
      body += '<text x="' + (startX + 16) + '" y="' + (startY + 46) + '" font-size="11" fill="' + C.teal + '">' + wrapText("3 reviewers read the screen cold", 32, 2, startX + 16, 13) + '</text>';
    }

    var boxX = compact ? 190 : 470;
    var boxW = w - boxX - (compact ? 6 : 20);
    var boxH = compact ? 32 : 72;
    var vGap = compact ? 6 : 18;
    var totalH = outs.length * boxH + (outs.length - 1) * vGap;
    var top = h / 2 - totalH / 2;
    var toneColor = { green: C.green, amber: C.amber, red: C.red };
    var toneBg = { green: C.greenBg, amber: C.amberBg, red: C.redBg };

    outs.forEach(function (o, i) {
      var y = top + i * (boxH + vGap);
      var cyB = y + boxH / 2;
      var col = toneColor[o.tone], bg = toneBg[o.tone];

      /* branch: straight out of the start box, then a curve up/down into each branch */
      var c1 = midX + (boxX - midX) * 0.45;
      body += '<path d="M ' + (startX + startW + 3) + ' ' + (h / 2) + ' L ' + midX + ' ' + (h / 2) +
        ' C ' + c1 + ' ' + (h / 2) + ', ' + c1 + ' ' + cyB + ', ' + (boxX - 8) + ' ' + cyB + '" fill="none" stroke="' + col + '" stroke-width="' + (compact ? 1.4 : 2.2) + '" marker-end="url(#arrow-f-' + o.tone + ')"/>';

      body += '<rect x="' + boxX + '" y="' + y + '" width="' + boxW + '" height="' + boxH + '" rx="9" fill="' + bg + '" stroke="' + col + '" stroke-width="1.6"/>';
      body += '<text x="' + (boxX + (compact ? 8 : 14)) + '" y="' + (y + (compact ? 14 : 24)) + '" font-size="' + (compact ? 8.5 : 13) + '" fill="' + col + '" font-weight="800">' + escapeHtml(o.outcome.toUpperCase()) + '</text>';
      if (!compact) {
        body += '<text x="' + (boxX + 76) + '" y="' + (y + 24) + '" font-size="10.5" fill="' + C.muted + '">' + escapeHtml(o.whatHappened) + '</text>';
        body += '<text x="' + (boxX + 14) + '" y="' + (y + 46) + '" font-size="11.5" fill="' + col + '" font-weight="700">→ ' + escapeHtml(o.nextMoveShort) + '</text>';
      } else {
        body += '<text x="' + (boxX + 8) + '" y="' + (y + 25) + '" font-size="6.8" fill="' + col + '">' + escapeHtml(o.nextMoveShort) + '</text>';
      }
    });

    if (!compact) {
      body += '<text x="' + startX + '" y="24" font-size="12" fill="' + C.muted + '" font-weight="700">ONE WEEK IN, THREE WAYS OUT — ALL THREE ARE DECIDED IN ADVANCE</text>';
      body += '<text x="' + startX + '" y="' + (h - 12) + '" font-size="11" fill="' + C.muted + '">Deciding the next move before the result is in is the point: it keeps a bad week from being argued into a good one.</text>';
    }

    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 5. Operations Console wireframe (section 4) */
  function consoleWireframe(compact) {
    var w = compact ? 400 : 1000;
    var h = compact ? 200 : 520;
    var pad = compact ? 6 : 14;
    var body = '<rect x="' + pad + '" y="' + pad + '" width="' + (w - pad * 2) + '" height="' + (h - pad * 2) + '" rx="10" fill="' + C.card + '" stroke="' + C.border + '" stroke-width="1.4"/>';

    /* top bar */
    var barH = compact ? 20 : 44;
    body += '<rect x="' + pad + '" y="' + pad + '" width="' + (w - pad * 2) + '" height="' + barH + '" rx="10" fill="' + C.slateBg + '" stroke="' + C.slate + '" stroke-width="1"/>';
    body += '<rect x="' + (pad + 10) + '" y="' + (pad + barH / 2 - (compact ? 5 : 10)) + '" width="' + (compact ? 10 : 20) + '" height="' + (compact ? 10 : 20) + '" rx="5" fill="' + C.teal + '"/>';
    if (!compact) {
      body += '<text x="' + (pad + 40) + '" y="' + (pad + 28) + '" font-size="12" fill="' + C.text + '" font-weight="800">AI Operations Center</text>';
      ["Incidents", "Dependency Map", "Audit Log"].forEach(function (t, i) {
        body += '<text x="' + (pad + 190 + i * 110) + '" y="' + (pad + 28) + '" font-size="11" fill="' + (i === 0 ? C.teal : C.muted) + '" font-weight="' + (i === 0 ? 700 : 400) + '">' + t + '</text>';
      });
      body += '<rect x="' + (w - pad - 210) + '" y="' + (pad + 12) + '" width="110" height="20" rx="10" fill="' + C.greenBg + '" stroke="' + C.green + '" stroke-width="0.8"/>';
      body += '<text x="' + (w - pad - 155) + '" y="' + (pad + 26) + '" font-size="9.5" text-anchor="middle" fill="' + C.green + '" font-weight="700">Read-Only</text>';
      body += '<circle cx="' + (w - pad - 70) + '" cy="' + (pad + 22) + '" r="10" fill="' + C.slateBg + '" stroke="' + C.slate + '" stroke-width="0.8"/>';
      body += '<text x="' + (w - pad - 70) + '" y="' + (pad + 25.5) + '" font-size="8.5" text-anchor="middle" fill="' + C.slate + '" font-weight="800">MC</text>';
      body += '<text x="' + (pad + 40) + '" y="' + (pad + 40) + '" font-size="8.5" fill="' + C.muted + '">TOP BAR — brand, nav, environment pill, signed-in approver</text>';
    }

    /* sidebar */
    var contentY = pad + barH + (compact ? 4 : 10);
    var contentH = h - pad - contentY - (compact ? 4 : 10);
    var sideW = compact ? 96 : 250;
    body += '<rect x="' + pad + '" y="' + contentY + '" width="' + sideW + '" height="' + contentH + '" rx="8" fill="' + C.slateBg + '" stroke="' + C.slate + '" stroke-width="1"/>';
    if (!compact) body += '<text x="' + (pad + 12) + '" y="' + (contentY + 18) + '" font-size="9.5" fill="' + C.muted + '" font-weight="800" letter-spacing="0.06em">LEFT SIDEBAR — INCIDENT LIST</text>';

    var incidents = [
      { t: "SSIS load blocked by SQL chain", badge: "Critical", tone: "red", sel: true },
      { t: "SSRS report latency rising", badge: "Watching", tone: "amber", sel: false },
      { t: "Windows disk space warning", badge: "Resolved", tone: "green", sel: false },
      { t: "SSIS timeout, auto-recovered", badge: "Resolved", tone: "green", sel: false }
    ];
    var toneColor = { green: C.green, amber: C.amber, red: C.red };
    var toneBg = { green: C.greenBg, amber: C.amberBg, red: C.redBg };
    var itemH = compact ? 20 : 56;
    incidents.forEach(function (inc, i) {
      var y = contentY + (compact ? 8 : 28) + i * (itemH + (compact ? 3 : 8));
      if (y + itemH > contentY + contentH - 4) return;
      body += '<rect x="' + (pad + (compact ? 4 : 10)) + '" y="' + y + '" width="' + (sideW - (compact ? 8 : 20)) + '" height="' + itemH + '" rx="6" fill="' + (inc.sel ? C.card : "none") + '" stroke="' + (inc.sel ? C.teal : C.border) + '" stroke-width="' + (inc.sel ? 1.6 : 0.9) + '"/>';
      if (!compact) {
        body += '<rect x="' + (pad + 18) + '" y="' + (y + 8) + '" width="' + (inc.badge.length * 6 + 14) + '" height="15" rx="7.5" fill="' + toneBg[inc.tone] + '" stroke="' + toneColor[inc.tone] + '" stroke-width="0.7"/>';
        body += '<text x="' + (pad + 25) + '" y="' + (y + 19) + '" font-size="8.5" fill="' + toneColor[inc.tone] + '" font-weight="700">' + inc.badge + '</text>';
        body += '<text x="' + (pad + 18) + '" y="' + (y + 40) + '" font-size="9.5" fill="' + C.text + '">' + wrapText(inc.t, 32, 1, pad + 18, 10) + '</text>';
      } else {
        body += '<rect x="' + (pad + 8) + '" y="' + (y + 6) + '" width="' + (sideW - 24) + '" height="3" rx="1.5" fill="' + toneColor[inc.tone] + '" opacity="0.6"/>';
        body += '<rect x="' + (pad + 8) + '" y="' + (y + 12) + '" width="' + (sideW - 34) + '" height="3" rx="1.5" fill="' + C.muted + '" opacity="0.35"/>';
      }
    });

    /* main panel */
    var mainX = pad + sideW + (compact ? 5 : 12);
    var mainW = w - pad - mainX;
    body += '<rect x="' + mainX + '" y="' + contentY + '" width="' + mainW + '" height="' + contentH + '" rx="8" fill="' + C.card + '" stroke="' + C.border + '" stroke-width="1"/>';

    var blocks = [
      { label: "Incident header — title, severity, “correlated from 2 events”", tone: "red", lines: 1 },
      { label: "Correlated events — raw timestamps, hosts, messages", tone: "slate", lines: 2 },
      { label: "Root cause, explained by Claude — one causal paragraph", tone: "teal", lines: 3 },
      { label: "Downstream business impact — affected reports, delay", tone: "amber", lines: 1 },
      { label: "Recommended remediation + approval row (cut from Week 1)", tone: "red", lines: 2 },
      { label: "Technical summary / Executive summary tabs", tone: "green", lines: 1 }
    ];
    var toneAll = { green: C.green, amber: C.amber, red: C.red, teal: C.teal, slate: C.slate };
    var toneAllBg = { green: C.greenBg, amber: C.amberBg, red: C.redBg, teal: C.tealBg, slate: C.slateBg };

    var totalLines = blocks.reduce(function (a, b) { return a + b.lines; }, 0);
    var avail = contentH - (compact ? 12 : 30) - blocks.length * (compact ? 4 : 10);
    var unit = avail / totalLines;
    var by = contentY + (compact ? 6 : 16);
    blocks.forEach(function (b) {
      var bh = unit * b.lines;
      body += '<rect x="' + (mainX + (compact ? 5 : 14)) + '" y="' + by + '" width="' + (mainW - (compact ? 10 : 28)) + '" height="' + bh + '" rx="7" fill="' + toneAllBg[b.tone] + '" stroke="' + toneAll[b.tone] + '" stroke-width="1"/>';
      if (!compact) {
        body += '<text x="' + (mainX + 26) + '" y="' + (by + 18) + '" font-size="10.5" fill="' + toneAll[b.tone] + '" font-weight="700">' + escapeHtml(b.label) + '</text>';
        for (var li = 1; li < b.lines * 2; li++) {
          var ly = by + 28 + (li - 1) * 13;
          if (ly > by + bh - 8) break;
          body += '<rect x="' + (mainX + 26) + '" y="' + ly + '" width="' + ((mainW - 70) * (li % 3 === 0 ? 0.55 : 0.85)) + '" height="4" rx="2" fill="' + toneAll[b.tone] + '" opacity="0.22"/>';
        }
      }
      by += bh + (compact ? 4 : 10);
    });

    if (!compact) {
      body += '<text x="' + mainX + '" y="' + (contentY - 4) + '" font-size="9.5" fill="' + C.muted + '" font-weight="800" letter-spacing="0.06em">MAIN PANEL — THE SELECTED INCIDENT, TOP TO BOTTOM</text>';
    }

    return svgWrap("0 0 " + w + " " + h, body);
  }

  /* 6. Simple glyph preview for tiles with no dedicated figure */
  function simplePreview(sectionId) {
    var w = 400, h = 130;
    var icon = { pitch: "❝ ❞", appendix: "◌" }[sectionId] || "•";
    return svgWrap("0 0 " + w + " " + h, '<text x="' + (w / 2) + '" y="' + (h / 2 + 14) + '" font-size="42" text-anchor="middle" fill="var(--accent,#0f766e)" opacity="0.35">' + icon + '</text>');
  }

  var svgGen = {
    bet: inputsToVerdict,
    fivedays: fiveDayStrip,
    cuts: keptVsCut,
    mockup: consoleWireframe,
    pitch: null,
    outcome: fridayFork,
    appendix: null
  };

  /* ------------------------------------------------------------------ */
  /* Command Center tile grid                                           */
  /* ------------------------------------------------------------------ */

  function tileCounts() {
    return {
      bet: MVP.building.length + " things being built",
      fivedays: MVP.fiveDays.length + " days, " + MVP.fiveDays.length + " outcomes",
      cuts: MVP.cuts.length + " deliberate cuts",
      mockup: MVP.mockup.notes.length + " things worth noticing",
      pitch: MVP.pitch.bullets.length + " value claims",
      outcome: MVP.outcomes.length + " outcomes",
      appendix: MVP.provesNothing.length + " open questions"
    };
  }

  function renderTileGrid(containerId) {
    var container = byId(containerId);
    if (!container) return;
    var counts = tileCounts();
    container.innerHTML = MVP.sections.map(function (s) {
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

  /* ------------------------------------------------------------------ */
  /* Ask panel: Search mode (no key) + Claude mode (own API key)        */
  /* ------------------------------------------------------------------ */

  var HAIKU_ID = "claude-haiku-4-5-20251001";

  function sectionSlice(pageId) {
    switch (pageId) {
      case "bet": return { question: MVP.question, building: MVP.building };
      case "fivedays": return { fiveDays: MVP.fiveDays, question: MVP.question };
      case "cuts": return { cuts: MVP.cuts, stackCutdown: MVP.stackCutdown, building: MVP.building };
      case "mockup": return { mockup: MVP.mockup, building: MVP.building };
      case "pitch": return { pitch: MVP.pitch };
      case "outcome": return { successBar: MVP.successBar, failureBar: MVP.failureBar, outcomes: MVP.outcomes };
      case "appendix": return { provesNothing: MVP.provesNothing, groundedIn: MVP.groundedIn };
      default: return MVP;
    }
  }

  function buildSystemPrompt(scope, pageId) {
    var data = scope === "section" ? sectionSlice(pageId) : MVP;
    return "You are answering questions about a Week 1 MVP plan for a project called \"" + MVP.meta.title +
      "\". Answer ONLY using the JSON data below. Do not use outside knowledge beyond what is stated in this data.\n\n" +
      "This plan is a deliberate subtraction. Its value comes from what it refuses to build. Protect that discipline:\n" +
      "- If the user asks to add back something listed in `cuts` (or anything the plan defers), do not simply agree. First say what that addition would cost — the scope it adds to a five-day week, the new risk it introduces, and the days it would take from the one question Week 1 is actually answering — and quote the plan's own stated reason for the cut. Only then, if the user still wants it, help them think it through honestly, including what would have to come out of the week to make room.\n" +
      "- Do not soften the failure criteria, the “Fail” outcome, or anything in `provesNothing`. If a claim is labelled an estimate in the pitch, keep it labelled an estimate.\n" +
      "- Never imply Week 1 proves something it explicitly does not.\n\n" +
      "If the answer is not present in this data, say so plainly and tell the user to try Search mode (the “Search — no key” tab in this panel), which works fully offline over the whole plan. Be concise and specific.\n\n" +
      "MVP_DATA:\n" + JSON.stringify(data, null, 2);
  }

  function initAsk(pageId) {
    var root = document.body;
    var panel = el("div", { class: "ask-panel" });
    panel.innerHTML = '<button class="ask-fab" id="ask-fab" type="button" aria-label="Ask about this MVP plan">?</button>';
    root.appendChild(panel);

    var win = el("div", { class: "ask-window", id: "ask-window" });
    win.innerHTML =
      '<div class="ask-header">' +
        '<div class="ask-title"><span>Ask about the plan</span><button class="icon-btn label-btn" id="ask-close" type="button">Close</button></div>' +
        '<div class="ask-modes">' +
          '<button class="ask-mode-btn active" id="ask-mode-search" type="button">Search — no key</button>' +
          '<button class="ask-mode-btn" id="ask-mode-claude" type="button">Claude — needs key</button>' +
        '</div>' +
        '<div class="ask-scope-row" id="ask-claude-config" style="display:none;">' +
          '<label>Scope: <select id="ask-scope"><option value="section">This section</option><option value="whole">Whole plan</option></select></label>' +
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
      '<div class="ask-body" id="ask-body"><div class="ask-hint">Ask a question about the Week 1 plan. Search mode works fully offline, right now.</div></div>' +
      '<div class="ask-footer">' +
        '<input type="text" id="ask-input" placeholder="e.g. why is Kafka cut?">' +
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
      var savedKey = localStorage.getItem("mvp-anthropic-key");
      if (savedKey) keyInput.value = savedKey;
    } catch (e) {}
    keyInput.addEventListener("change", function () {
      try { localStorage.setItem("mvp-anthropic-key", keyInput.value); } catch (e) {}
    });
    var modelSelect = byId("ask-model");
    try {
      var savedModel = localStorage.getItem("mvp-anthropic-model");
      if (savedModel) modelSelect.value = savedModel;
    } catch (e) {}
    modelSelect.addEventListener("change", function () {
      try { localStorage.setItem("mvp-anthropic-model", modelSelect.value); } catch (e) {}
    });

    var body = byId("ask-body");
    var input = byId("ask-input");
    var submit = byId("ask-submit");

    function runSearch(query) {
      var terms = tokenize(query);
      var hits = search(query, { limit: 8 });
      if (!hits.length) {
        body.innerHTML = '<div class="ask-hint">No matches for “' + escapeHtml(query) + '”. That gap may itself be the answer — check <a href="07-appendix.html">what Week 1 proves nothing about</a>.</div>';
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
      return '<div class="ask-error">' + escapeHtml(msg) + ' Switch to <strong>Search — no key</strong> mode above — it works fully offline over the whole plan.</div>';
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
  }

  return {
    init: init,
    search: search,
    tokenize: tokenize,
    highlight: highlight,
    escapeHtml: escapeHtml,
    registerSearchable: registerSearchable,
    renderStaticFigure: renderStaticFigure,
    sectionMeta: sectionMeta,
    tonePillClass: function (tone) { return TONE_PILL[tone] || "pill-slate"; },
    svg: {
      inputsToVerdict: inputsToVerdict,
      fiveDayStrip: fiveDayStrip,
      keptVsCut: keptVsCut,
      fridayFork: fridayFork,
      consoleWireframe: consoleWireframe
    }
  };
})();
