/*
  Shared rendering, navigation, search, and Ask-agent logic for every page
  in this knowledge base. Loaded after assets/blueprint.js via a classic
  <script> tag — references the bare `BLUEPRINT` identifier, never
  `window.BLUEPRINT`. No ES modules, no fetch() of local files: this all
  has to work opened straight from disk over file://.
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

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function tokenize(text) {
    return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(function (w) {
      return w.length > 1 && !STOPWORDS.has(w);
    });
  }

  function stem(w) {
    if (w.length > 5 && w.slice(-3) === "ing") return w.slice(0, -3);
    if (w.length > 6 && w.slice(-4) === "edly") return w.slice(0, -4);
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

  /* ------------------------------------------------------------------ */
  /* Search index — built once over every field of BLUEPRINT            */
  /* ------------------------------------------------------------------ */

  var _index = null;

  function sectionMeta(id) {
    return BLUEPRINT.sections.filter(function (s) { return s.id === id; })[0] || null;
  }

  function buildIndex() {
    if (_index) return _index;
    var idx = [];
    function push(sectionId, title, text) {
      var sec = sectionMeta(sectionId);
      if (!sec) return;
      idx.push({ sectionId: sectionId, file: sec.file, sectionTitle: sec.shortTitle, title: title, text: text });
    }

    push("idea", "The Idea", BLUEPRINT.idea.paragraph);
    BLUEPRINT.idea.requirements.forEach(function (r) {
      push("idea", r.phrase, r.phrase + " — drives " + r.drives);
    });

    BLUEPRINT.components.forEach(function (c) {
      push("components", c.name, [c.summary, "Words: " + c.words.join(", "), "Technology: " + c.technology].join(". "));
    });

    push("architecture", "Deployment topology", BLUEPRINT.architecture.deploymentNotes);
    push("architecture", "Security notes", BLUEPRINT.architecture.securityNotes);
    push("architecture", "Architecture interpretation", BLUEPRINT.architecture.interpretation);

    BLUEPRINT.dataFlow.steps.forEach(function (s) {
      push("dataflow", "Step " + s.n + ": " + s.title, s.detail);
    });

    BLUEPRINT.buildOrder.phases.forEach(function (p) {
      push("buildorder", "Phase " + p.n + ": " + p.name, "Builds: " + p.builds.join(", ") + ". Proves: " + p.proves);
    });

    BLUEPRINT.assumptions.forEach(function (a, i) {
      push("assumptions", "Assumption " + (i + 1), a.assumption + " Impact: " + a.impact);
    });

    BLUEPRINT.notCovered.forEach(function (n) {
      push("coverage", n.item, n.why);
    });
    BLUEPRINT.coverage.forEach(function (c) {
      push("coverage", c.concern, c.status + ": " + c.note);
    });
    push("coverage", "Open question", BLUEPRINT.openQuestion.question +
      " Fork A — " + BLUEPRINT.openQuestion.forkA.label + ": " + BLUEPRINT.openQuestion.forkA.consequence +
      " Fork B — " + BLUEPRINT.openQuestion.forkB.label + ": " + BLUEPRINT.openQuestion.forkB.consequence);

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

  var _mermaidJobs = [];

  function initTheme(btn) {
    var saved = null;
    try { saved = localStorage.getItem("bp-theme"); } catch (e) {}
    if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved);
    function paint() { btn.textContent = currentTheme() === "dark" ? "Light" : "Dark"; }
    paint();
    btn.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("bp-theme", next); } catch (e) {}
      paint();
      rerenderMermaid();
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
        '<a class="brand" href="index.html"><span class="brand-badge">AI</span><span>' + escapeHtml(BLUEPRINT.meta.title) + '</span></a>' +
        (isIndex ? "" : '<a class="cc-link" href="index.html">← Command Center</a>') +
        '<div class="topnav-spacer"></div>' +
        '<div class="search-box">' +
          '<span class="search-icon">⌕</span>' +
          '<input type="text" id="nav-search-input" placeholder="Search the blueprint…" autocomplete="off" aria-label="Search the blueprint">' +
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
        results.innerHTML = '<div class="search-empty">No matches for “' + escapeHtml(q) + '”. Check <a href="07-not-covered.html">Coverage</a> — a miss may itself be the answer.</div>';
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

  /* Elements registered via Site.registerSearchable() get hidden/shown
     as the nav search box narrows the current page's own content. */
  var _searchableEls = [];
  function registerSearchable(selector) {
    document.querySelectorAll(selector).forEach(function (e) { _searchableEls.push(e); });
  }
  function applyOnPageNarrowing(query) {
    var q = (query || "").trim().toLowerCase();
    if (q.length < 2) {
      _searchableEls.forEach(function (e) { e.style.display = ""; });
      return;
    }
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
    var sections = BLUEPRINT.sections;
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
    var f = el("footer", { class: "site-footer" }, '<div class="wrap">' + escapeHtml(BLUEPRINT.meta.generatedNote) + '</div>');
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

  function openViewer(title, type, payload) {
    ensureViewer();
    _viewerState.zoom = 1; _viewerState.panX = 0; _viewerState.panY = 0;
    byId("viewer-title").textContent = title;
    var inner = byId("viewer-stage-inner");
    inner.style.transform = "translate(0px,0px) scale(1)";
    if (type === "svg") {
      inner.innerHTML = payload;
    } else if (type === "chart") {
      inner.innerHTML = "";
      var canvas = el("canvas", { width: "720", height: "620" });
      inner.appendChild(canvas);
      /* eslint-disable-next-line no-new */
      new Chart(canvas.getContext("2d"), JSON.parse(JSON.stringify(payload)));
    }
    byId("viewer-overlay").classList.add("open");
  }
  function closeViewer() { var o = byId("viewer-overlay"); if (o) o.classList.remove("open"); }

  /* ------------------------------------------------------------------ */
  /* Figure mounting: static SVG, Mermaid, Chart.js                     */
  /* ------------------------------------------------------------------ */

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
    byId(containerId + "-body").innerHTML = opts.svgMarkup;
    appendInterpretation(container, opts.interpretation);
    container.querySelector(".expand-btn").addEventListener("click", function () {
      openViewer(opts.title, "svg", opts.svgMarkup);
    });
  }

  function mermaidTheme() { return currentTheme() === "dark" ? "dark" : "default"; }

  function renderMermaidFigure(containerId, opts) {
    var container = figureShell(containerId, opts.title);
    if (!container) return;
    var bodyEl = byId(containerId + "-body");
    bodyEl.innerHTML = '<div class="ask-hint">Rendering diagram…</div>';
    appendInterpretation(container, opts.interpretation);
    container.querySelector(".expand-btn").addEventListener("click", function () {
      var svg = bodyEl.querySelector("svg");
      if (svg) openViewer(opts.title, "svg", svg.outerHTML);
    });

    function attempt(retriesLeft) {
      var renderId = "mmd-" + containerId + "-" + Date.now() + "-" + retriesLeft;
      mermaid.render(renderId, opts.source).then(function (res) {
        /* Mermaid occasionally mis-measures on a cold first render (seen on
           gantt charts) and emits negative rect widths — invalid SVG that
           paints as blank. Detect it and re-render once rather than show
           a broken diagram. */
        if (/width="-/.test(res.svg) && retriesLeft > 0) {
          attempt(retriesLeft - 1);
          return;
        }
        bodyEl.innerHTML = res.svg;
      }).catch(function (err) {
        bodyEl.innerHTML = '<div class="ask-hint">Could not render diagram: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
      });
    }

    function draw() {
      if (typeof mermaid === "undefined") {
        bodyEl.innerHTML = '<div class="ask-hint">Diagram engine (Mermaid) did not load — this page needs an internet connection on first load.</div>';
        return;
      }
      mermaid.initialize({ startOnLoad: false, theme: mermaidTheme(), securityLevel: "loose", fontFamily: "Segoe UI, system-ui, sans-serif" });
      attempt(2);
    }
    _mermaidJobs.push(draw);
    draw();
  }

  function rerenderMermaid() { _mermaidJobs.forEach(function (fn) { fn(); }); }

  function renderChartFigure(containerId, opts) {
    var container = figureShell(containerId, opts.title);
    if (!container) return;
    var bodyEl = byId(containerId + "-body");
    if (typeof Chart === "undefined") {
      bodyEl.innerHTML = '<div class="ask-hint">Chart engine (Chart.js) did not load — this page needs an internet connection on first load.</div>';
      appendInterpretation(container, opts.interpretation);
      return;
    }
    var canvas = el("canvas", { width: "360", height: "300" });
    bodyEl.appendChild(canvas);
    /* eslint-disable-next-line no-new */
    new Chart(canvas.getContext("2d"), opts.config);
    appendInterpretation(container, opts.interpretation);
    container.querySelector(".expand-btn").addEventListener("click", function () {
      openViewer(opts.title, "chart", opts.config);
    });
  }

  /* ------------------------------------------------------------------ */
  /* SVG illustrations, generated from BLUEPRINT                        */
  /* ------------------------------------------------------------------ */

  var PALETTE = {
    collector: "#1d4ed8", infra: "#475569", store: "#475569", service: "#0f766e",
    agent: "#0f766e", frontend: "#0369a1", external: "#b45309", actor: "#15803d"
  };

  function svgWrap(viewBox, body) {
    return '<svg viewBox="' + viewBox + '" xmlns="http://www.w3.org/2000/svg" role="img" style="width:100%;height:auto;font-family:Segoe UI, system-ui, sans-serif;">' + body + '</svg>';
  }

  function ideaPipeline(compact) {
    var stages = BLUEPRINT.idea.pipelineStages;
    var w = compact ? 400 : 1080, h = compact ? 150 : 220;
    var textCol = "var(--text,#0f172a)", mutedCol = "var(--muted,#64748b)", borderCol = "var(--border,#e2e8f0)";
    var stageW = compact ? 46 : 150, gap = compact ? 6 : 18;
    var startX = compact ? 70 : 150;
    var y = h / 2 - (compact ? 14 : 22);
    var boxH = compact ? 28 : 44;
    var body = "";
    body += '<text x="' + (compact ? 8 : 14) + '" y="' + (h / 2 + 4) + '" font-size="' + (compact ? 9 : 12) + '" fill="' + mutedCol + '" font-weight="700">INPUT</text>';
    var inputs = BLUEPRINT.idea.inputs;
    inputs.forEach(function (label, i) {
      var iy = 14 + i * ((h - 28) / inputs.length);
      if (!compact) {
        body += '<polygon points="' + [[0,10],[64,0],[128,10],[64,20]].map(function(p){return (p[0]) + "," + (iy + p[1]);}).join(" ") + '" fill="var(--c-amber-bg,#fffbeb)" stroke="var(--c-amber,#b45309)" stroke-width="1.2"/>';
        body += '<text x="64" y="' + (iy + 14) + '" font-size="10.5" text-anchor="middle" fill="var(--c-amber,#b45309)" font-weight="700">' + escapeHtml(label) + '</text>';
      }
    });
    if (compact) {
      body += '<rect x="6" y="' + (h/2-22) + '" width="52" height="44" rx="8" fill="var(--c-amber-bg,#fffbeb)" stroke="var(--c-amber,#b45309)"/>';
      body += '<text x="32" y="' + (h/2+4) + '" font-size="9" text-anchor="middle" fill="var(--c-amber,#b45309)" font-weight="700">' + inputs.length + ' platforms</text>';
    }
    stages.forEach(function (s, i) {
      var x = startX + i * (stageW + gap);
      var fill = s.agent ? "var(--c-teal-bg,#f0fdfa)" : "var(--c-slate-bg,#f1f5f9)";
      var stroke = s.agent ? "var(--c-teal,#0f766e)" : "var(--c-slate,#475569)";
      body += '<rect x="' + x + '" y="' + y + '" width="' + stageW + '" height="' + boxH + '" rx="8" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.2"/>';
      if (!compact) body += '<text x="' + (x + stageW/2) + '" y="' + (y + boxH/2 + 4) + '" font-size="10.5" text-anchor="middle" fill="' + stroke + '" font-weight="700">' + escapeHtml(s.label) + '</text>';
      if (i < stages.length - 1) {
        var ax = x + stageW;
        body += '<line x1="' + ax + '" y1="' + (y + boxH/2) + '" x2="' + (ax + gap) + '" y2="' + (y + boxH/2) + '" stroke="' + borderCol + '" stroke-width="2" marker-end="url(#arrow)"/>';
      }
    });
    var outX = startX + stages.length * (stageW + gap) + (compact ? 0 : 10);
    body += '<line x1="' + (startX + stages.length*(stageW+gap) - gap) + '" y1="' + (y+boxH/2) + '" x2="' + outX + '" y2="' + (y+boxH/2) + '" stroke="' + borderCol + '" stroke-width="2" marker-end="url(#arrow)"/>';
    body += '<rect x="' + outX + '" y="' + (y - (compact?6:10)) + '" width="' + (compact ? 44 : 190) + '" height="' + (boxH + (compact?12:20)) + '" rx="8" fill="var(--c-green-bg,#ecfdf3)" stroke="var(--c-green,#15803d)" stroke-width="1.4"/>';
    body += '<text x="' + (outX + (compact?22:95)) + '" y="' + (y + boxH/2 + 4) + '" font-size="' + (compact?9:10.5) + '" text-anchor="middle" fill="var(--c-green,#15803d)" font-weight="700">' + (compact ? "Incident" : "Incident: root cause + impact + fix + summary") + '</text>';
    var defs = '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="' + borderCol + '"/></marker></defs>';
    return svgWrap("0 0 " + (outX + (compact?54:210)) + " " + h, defs + body);
  }

  function componentLayers(compact) {
    var cats = BLUEPRINT.categories;
    var w = compact ? 400 : 1080;
    var rowH = compact ? 20 : 46;
    var h = 10 + cats.length * (rowH + (compact?4:10));
    var body = "";
    var y = 10;
    cats.forEach(function (cat) {
      var comps = BLUEPRINT.components.filter(function (c) { return c.category === cat.id; });
      if (!comps.length) return;
      var color = PALETTE[cat.id] || "#475569";
      body += '<rect x="10" y="' + y + '" width="' + (w-20) + '" height="' + rowH + '" rx="7" fill="color-mix(in srgb, ' + color + ' 10%, transparent)" stroke="' + color + '" stroke-width="1"/>';
      if (compact) {
        body += '<circle cx="24" cy="' + (y + rowH/2) + '" r="5" fill="' + color + '"/>';
        body += '<text x="38" y="' + (y+rowH/2+4) + '" font-size="9.5" fill="' + color + '" font-weight="700">' + escapeHtml(cat.label) + ' (' + comps.length + ')</text>';
      } else {
        body += '<text x="20" y="' + (y + 16) + '" font-size="10.5" fill="' + color + '" font-weight="800" letter-spacing="0.04em">' + escapeHtml(cat.label.toUpperCase()) + ' — ' + comps.length + '</text>';
        var cx = 20;
        comps.forEach(function (c) {
          var chipW = Math.max(60, c.name.length * 6.4);
          if (cx + chipW > w - 30) return;
          body += '<rect x="' + cx + '" y="' + (y+22) + '" width="' + chipW + '" height="18" rx="9" fill="' + color + '" opacity="0.14"/>';
          body += '<text x="' + (cx+chipW/2) + '" y="' + (y+34) + '" font-size="9" text-anchor="middle" fill="' + color + '" font-weight="600">' + escapeHtml(c.name) + '</text>';
          cx += chipW + 8;
        });
      }
      y += rowH + (compact?4:10);
    });
    return svgWrap("0 0 " + w + " " + y, body);
  }

  function architectureLayers(compact) {
    var columns = [
      { title: "External", match: function (c) { return c.id === "platforms"; } },
      { title: "Collect", match: function (c) { return c.category === "collector"; } },
      { title: "Store & Bus", match: function (c) { return c.category === "infra" || c.category === "store"; } },
      { title: "Orchestrate", match: function (c) { return c.category === "service"; } },
      { title: "AI Agents", match: function (c) { return c.category === "agent" || c.id === "claude-api"; } },
      { title: "Console & User", match: function (c) { return c.category === "frontend" || c.category === "actor"; } }
    ];
    var w = compact ? 400 : 1080;
    var colW = w / columns.length;
    var h = compact ? 150 : 300;
    var body = "";
    var defs = '<defs><marker id="arrow2" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--muted,#64748b)"/></marker></defs>';
    columns.forEach(function (col, ci) {
      var comps = BLUEPRINT.components.filter(col.match);
      var x = ci * colW + 8;
      var cw = colW - 16;
      if (!compact) body += '<text x="' + (x+cw/2) + '" y="16" font-size="10" text-anchor="middle" fill="var(--muted,#64748b)" font-weight="700">' + escapeHtml(col.title) + '</text>';
      var boxTop = compact ? 8 : 26;
      var boxH = compact ? Math.min(18, (h-16)/Math.max(comps.length,1) - 4) : 30;
      comps.forEach(function (c, i) {
        var color = PALETTE[c.category] || "#475569";
        var by = boxTop + i * (boxH + 6);
        body += '<rect x="' + x + '" y="' + by + '" width="' + cw + '" height="' + boxH + '" rx="6" fill="color-mix(in srgb, ' + color + ' 12%, transparent)" stroke="' + color + '" stroke-width="1"/>';
        if (!compact) body += '<text x="' + (x+cw/2) + '" y="' + (by + boxH/2 + 3.5) + '" font-size="8.6" text-anchor="middle" fill="' + color + '" font-weight="600">' + escapeHtml(c.name) + '</text>';
      });
      if (ci < columns.length - 1) {
        var midY = compact ? h/2 : (boxTop + 20);
        body += '<line x1="' + (x+cw+2) + '" y1="' + midY + '" x2="' + (x+colW-6) + '" y2="' + midY + '" stroke="var(--muted,#64748b)" stroke-width="1.6" marker-end="url(#arrow2)"/>';
      }
    });
    return svgWrap("0 0 " + w + " " + h, defs + body);
  }

  function stepsRibbon(compact) {
    var steps = BLUEPRINT.dataFlow.steps;
    var w = compact ? 400 : 1080;
    var h = compact ? 100 : 210;
    var pad = 30;
    var gap = (w - pad * 2) / (steps.length - 1);
    var midY = compact ? h/2 : 90;
    var body = '<line x1="' + pad + '" y1="' + midY + '" x2="' + (w-pad) + '" y2="' + midY + '" stroke="var(--border,#e2e8f0)" stroke-width="2"/>';
    steps.forEach(function (s, i) {
      var x = pad + i * gap;
      var color = s.touchesModel ? "#0f766e" : "#475569";
      var r = compact ? 7 : 11;
      body += '<circle cx="' + x + '" cy="' + midY + '" r="' + r + '" fill="' + (s.touchesModel ? "var(--c-teal-bg,#f0fdfa)" : "var(--c-slate-bg,#f1f5f9)") + '" stroke="' + color + '" stroke-width="2"/>';
      body += '<text x="' + x + '" y="' + (midY+4) + '" font-size="' + (compact?8:10) + '" text-anchor="middle" fill="' + color + '" font-weight="700">' + s.n + '</text>';
      if (!compact) {
        var up = i % 2 === 0;
        var ty = up ? midY - 26 : midY + 40;
        body += '<line x1="' + x + '" y1="' + (up ? midY - r : midY + r) + '" x2="' + x + '" y2="' + (up ? ty + 6 : ty - 6) + '" stroke="' + color + '" stroke-width="1" opacity="0.5"/>';
        body += '<text x="' + x + '" y="' + ty + '" font-size="8.6" text-anchor="middle" fill="var(--text,#0f172a)" font-weight="600">' + wrapText(s.title, 16, x) + '</text>';
      }
    });
    if (compact) {
      body += '<text x="' + (w/2) + '" y="' + (midY + 26) + '" font-size="9" text-anchor="middle" fill="var(--muted,#64748b)">' + steps.length + ' steps — teal touches Claude</text>';
    }
    return svgWrap("0 0 " + w + " " + h, body);
  }

  function wrapText(text, maxChars, x) {
    var tspanX = x == null ? 0 : x;
    var words = text.split(" ");
    var lines = []; var cur = "";
    words.forEach(function (w) {
      if ((cur + " " + w).trim().length > maxChars) { lines.push(cur.trim()); cur = w; }
      else cur = (cur + " " + w).trim();
    });
    if (cur) lines.push(cur.trim());
    lines = lines.slice(0, 2);
    return lines.map(function (l, i) { return '<tspan x="' + tspanX + '" dy="' + (i === 0 ? 0 : 11) + '">' + escapeHtml(l) + '</tspan>'; }).join("");
  }

  function phaseTimeline(compact) {
    var phases = BLUEPRINT.buildOrder.phases;
    var totalWeeks = phases.reduce(function (a, p) { return a + p.weeks; }, 0);
    var w = compact ? 400 : 1080;
    var h = compact ? 90 : 150;
    var barY = compact ? 30 : 40;
    var barH = compact ? 30 : 50;
    var riskColor = { low: "#475569", medium: "#b45309", high: "#b91c1c" };
    var x = 10;
    var usableW = w - 20;
    var body = "";
    phases.forEach(function (p) {
      var segW = (p.weeks / totalWeeks) * usableW;
      var color = riskColor[p.risk] || "#475569";
      var crit = p.risk === "high";
      body += '<rect x="' + x + '" y="' + barY + '" width="' + segW + '" height="' + barH + '" fill="color-mix(in srgb, ' + color + ' 16%, transparent)" stroke="' + color + '" stroke-width="' + (crit ? 2.4 : 1.2) + '" stroke-dasharray="' + (crit ? "0" : "0") + '"/>';
      if (!compact) {
        body += '<text x="' + (x + segW/2) + '" y="' + (barY + barH/2 - 4) + '" font-size="9.5" text-anchor="middle" fill="' + color + '" font-weight="700">' + escapeHtml(p.name) + '</text>';
        body += '<text x="' + (x + segW/2) + '" y="' + (barY + barH/2 + 10) + '" font-size="8.5" text-anchor="middle" fill="' + color + '">' + p.weeks + "w" + '</text>';
      }
      if (crit && !compact) {
        body += '<text x="' + (x + segW/2) + '" y="' + (barY - 8) + '" font-size="8.5" text-anchor="middle" fill="' + color + '" font-weight="800">MAKE-OR-BREAK</text>';
      }
      x += segW;
    });
    if (compact) body += '<text x="' + (w/2) + '" y="' + (barY+barH+18) + '" font-size="9" text-anchor="middle" fill="var(--muted,#64748b)">' + phases.length + ' phases · ' + totalWeeks + ' weeks</text>';
    return svgWrap("0 0 " + w + " " + h, body);
  }

  function assumptionsRibbon(compact) {
    var items = BLUEPRINT.assumptions;
    var w = compact ? 400 : 1080;
    var h = compact ? 100 : 170;
    var pad = 40;
    var gap = (w - pad*2) / (items.length - 1);
    var midY = compact ? h/2 - 6 : 70;
    var body = "";
    items.forEach(function (a, i) {
      var x = pad + i * gap;
      var noImpact = /no architectural impact/i.test(a.impact);
      var color = noImpact ? "#475569" : "#b45309";
      var r = compact ? 9 : 15;
      body += '<circle cx="' + x + '" cy="' + midY + '" r="' + r + '" fill="' + (noImpact ? "var(--c-slate-bg,#f1f5f9)" : "var(--c-amber-bg,#fffbeb)") + '" stroke="' + color + '" stroke-width="2"/>';
      body += '<text x="' + x + '" y="' + (midY+4) + '" font-size="' + (compact?9:11) + '" text-anchor="middle" fill="' + color + '" font-weight="700">A' + (i+1) + '</text>';
      if (!compact) {
        body += '<text x="' + x + '" y="' + (midY + r + 20) + '" font-size="8.4" text-anchor="middle" fill="var(--text,#0f172a)" font-weight="600">' + wrapText(noImpact ? "No architectural impact" : "Changes the design", 18, x) + '</text>';
      }
    });
    if (compact) body += '<text x="' + (w/2) + '" y="' + (midY + 30) + '" font-size="9" text-anchor="middle" fill="var(--muted,#64748b)">' + items.length + ' assumptions — amber changes the design</text>';
    return svgWrap("0 0 " + w + " " + h, body);
  }

  function coverageGrid(compact) {
    var rows = BLUEPRINT.coverage;
    var cols = compact ? 6 : 6;
    var cell = compact ? 24 : 92;
    var gap = compact ? 4 : 10;
    var w = cols * (cell + gap) + gap;
    var rowsCount = Math.ceil(rows.length / cols);
    var h = rowsCount * (cell*(compact?0.6:0.42) + gap) + gap + (compact?0:20);
    var statusColor = { covered: "#15803d", partial: "#b45309", "not-covered": "#b91c1c" };
    var statusBg = { covered: "var(--c-green-bg,#ecfdf3)", partial: "var(--c-amber-bg,#fffbeb)", "not-covered": "var(--c-red-bg,#fef2f2)" };
    var cellH = cell * (compact ? 0.6 : 0.42);
    var body = "";
    rows.forEach(function (r, i) {
      var col = i % cols, row = Math.floor(i / cols);
      var x = gap + col * (cell + gap);
      var y = gap + row * (cellH + gap);
      var color = statusColor[r.status] || "#475569";
      body += '<rect x="' + x + '" y="' + y + '" width="' + cell + '" height="' + cellH + '" rx="5" fill="' + statusBg[r.status] + '" stroke="' + color + '" stroke-width="1.3"><title>' + escapeHtml(r.concern) + '</title></rect>';
      if (!compact) {
        body += '<text x="' + (x+cell/2) + '" y="' + (y+cellH/2+3) + '" font-size="7" text-anchor="middle" fill="' + color + '" font-weight="700">' + wrapText(r.concern, 20, x+cell/2) + '</text>';
      }
    });
    if (!compact) {
      var legendY = h - 12;
      var lx = gap;
      [["covered","Covered"],["partial","Partial"],["not-covered","Not covered"]].forEach(function (pair) {
        body += '<circle cx="' + (lx+5) + '" cy="' + legendY + '" r="5" fill="' + statusColor[pair[0]] + '"/>';
        body += '<text x="' + (lx+14) + '" y="' + (legendY+3) + '" font-size="9" fill="var(--text,#0f172a)">' + pair[1] + '</text>';
        lx += 100;
      });
    }
    return svgWrap("0 0 " + w + " " + h, body);
  }

  function openQuestionFork(compact) {
    var oq = BLUEPRINT.openQuestion;
    var w = compact ? 400 : 900;
    var h = compact ? 130 : 260;
    var cx = compact ? 60 : 140;
    var midY = h/2;
    var body = "";
    body += '<circle cx="' + cx + '" cy="' + midY + '" r="' + (compact?18:34) + '" fill="var(--c-info-bg,#f0f9ff)" stroke="var(--c-info,#0369a1)" stroke-width="2"/>';
    body += '<text x="' + cx + '" y="' + (midY+4) + '" font-size="' + (compact?8:10.5) + '" text-anchor="middle" fill="var(--c-info,#0369a1)" font-weight="700">' + (compact ? "?" : "OPEN") + '</text>';
    var branchX = compact ? 210 : 520;
    var topY = compact ? 24 : 60, botY = compact ? h-24 : h-60;
    body += '<line x1="' + (cx+ (compact?18:34)) + '" y1="' + midY + '" x2="' + branchX + '" y2="' + topY + '" stroke="var(--c-green,#15803d)" stroke-width="2"/>';
    body += '<line x1="' + (cx+ (compact?18:34)) + '" y1="' + midY + '" x2="' + branchX + '" y2="' + botY + '" stroke="var(--c-amber,#b45309)" stroke-width="2"/>';
    var boxW = compact ? 170 : 340, boxH = compact ? 40 : 90;
    body += '<rect x="' + branchX + '" y="' + (topY-boxH/2) + '" width="' + boxW + '" height="' + boxH + '" rx="8" fill="var(--c-green-bg,#ecfdf3)" stroke="var(--c-green,#15803d)" stroke-width="1.4"/>';
    body += '<text x="' + (branchX+10) + '" y="' + (topY-boxH/2+16) + '" font-size="' + (compact?8:10) + '" fill="var(--c-green,#15803d)" font-weight="700">' + escapeHtml(oq.forkA.label) + '</text>';
    if (!compact) body += '<text x="' + (branchX+10) + '" y="' + (topY-boxH/2+34) + '" font-size="8.6" fill="var(--text,#0f172a)">' + wrapText(oq.forkA.consequence, 46, branchX+10) + '</text>';
    body += '<rect x="' + branchX + '" y="' + (botY-boxH/2) + '" width="' + boxW + '" height="' + boxH + '" rx="8" fill="var(--c-amber-bg,#fffbeb)" stroke="var(--c-amber,#b45309)" stroke-width="1.4"/>';
    body += '<text x="' + (branchX+10) + '" y="' + (botY-boxH/2+16) + '" font-size="' + (compact?8:10) + '" fill="var(--c-amber,#b45309)" font-weight="700">' + escapeHtml(oq.forkB.label) + '</text>';
    if (!compact) body += '<text x="' + (branchX+10) + '" y="' + (botY-boxH/2+34) + '" font-size="8.6" fill="var(--text,#0f172a)">' + wrapText(oq.forkB.consequence, 46, branchX+10) + '</text>';
    return svgWrap("0 0 " + (branchX+boxW+10) + " " + h, body);
  }

  var svgGen = {
    idea: ideaPipeline,
    components: componentLayers,
    architecture: architectureLayers,
    dataflow: stepsRibbon,
    buildorder: phaseTimeline,
    assumptions: assumptionsRibbon,
    coverage: coverageGrid
  };

  /* ------------------------------------------------------------------ */
  /* Command Center tile grid                                           */
  /* ------------------------------------------------------------------ */

  function renderTileGrid(containerId) {
    var container = byId(containerId);
    if (!container) return;
    var counts = {
      idea: BLUEPRINT.idea.requirements.length + " phrases",
      components: BLUEPRINT.components.length + " components",
      architecture: BLUEPRINT.architecture.mermaid.split("-->").length - 1 + " connections",
      dataflow: BLUEPRINT.dataFlow.steps.length + " steps",
      buildorder: BLUEPRINT.buildOrder.phases.length + " phases",
      assumptions: BLUEPRINT.assumptions.length + " assumptions",
      coverage: BLUEPRINT.notCovered.length + " not covered"
    };
    container.innerHTML = BLUEPRINT.sections.map(function (s) {
      var gen = svgGen[s.id];
      var svg = gen ? gen(true) : "";
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
      case "idea": return { idea: BLUEPRINT.idea };
      case "components": return { components: BLUEPRINT.components, categories: BLUEPRINT.categories };
      case "architecture": return { architecture: BLUEPRINT.architecture, components: BLUEPRINT.components };
      case "dataflow": return { dataFlow: BLUEPRINT.dataFlow };
      case "buildorder": return { buildOrder: BLUEPRINT.buildOrder };
      case "assumptions": return { assumptions: BLUEPRINT.assumptions };
      case "coverage": return { coverage: BLUEPRINT.coverage, notCovered: BLUEPRINT.notCovered, openQuestion: BLUEPRINT.openQuestion };
      default: return BLUEPRINT;
    }
  }

  function buildSystemPrompt(scope, pageId) {
    var data = scope === "section" ? sectionSlice(pageId) : BLUEPRINT;
    return "You are answering questions about an enterprise system architecture blueprint called \"" + BLUEPRINT.meta.title +
      "\". Answer ONLY using the JSON data below. Do not use outside knowledge beyond what is stated in this data. " +
      "If the answer is not present in this data, say so plainly and suggest the user try Search mode or check the Coverage page. Be concise and specific.\n\n" +
      "BLUEPRINT_DATA:\n" + JSON.stringify(data, null, 2);
  }

  function initAsk(pageId) {
    var root = document.body;
    var panel = el("div", { class: "ask-panel" });
    panel.innerHTML = '<button class="ask-fab" id="ask-fab" type="button" aria-label="Ask about this blueprint">?</button>';
    root.appendChild(panel);

    var win = el("div", { class: "ask-window", id: "ask-window" });
    win.innerHTML =
      '<div class="ask-header">' +
        '<div class="ask-title"><span>Ask the blueprint</span><button class="icon-btn label-btn" id="ask-close" type="button">Close</button></div>' +
        '<div class="ask-modes">' +
          '<button class="ask-mode-btn active" id="ask-mode-search" type="button">Search — no key</button>' +
          '<button class="ask-mode-btn" id="ask-mode-claude" type="button">Claude — needs key</button>' +
        '</div>' +
        '<div class="ask-scope-row" id="ask-claude-config" style="display:none;">' +
          '<label>Scope: <select id="ask-scope"><option value="section">This section</option><option value="whole">Whole blueprint</option></select></label>' +
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
      '<div class="ask-body" id="ask-body"><div class="ask-hint">Ask a question about this blueprint. Search mode works fully offline, right now.</div></div>' +
      '<div class="ask-footer">' +
        '<input type="text" id="ask-input" placeholder="e.g. what happens if a script fails?">' +
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
      var savedKey = localStorage.getItem("bp-anthropic-key");
      if (savedKey) keyInput.value = savedKey;
    } catch (e) {}
    keyInput.addEventListener("change", function () {
      try { localStorage.setItem("bp-anthropic-key", keyInput.value); } catch (e) {}
    });
    var modelSelect = byId("ask-model");
    try {
      var savedModel = localStorage.getItem("bp-anthropic-model");
      if (savedModel) modelSelect.value = savedModel;
    } catch (e) {}
    modelSelect.addEventListener("change", function () {
      try { localStorage.setItem("bp-anthropic-model", modelSelect.value); } catch (e) {}
    });

    var body = byId("ask-body");
    var input = byId("ask-input");
    var submit = byId("ask-submit");

    function runSearch(query) {
      var terms = tokenize(query);
      var hits = search(query, { limit: 8 });
      if (!hits.length) {
        body.innerHTML = '<div class="ask-hint">No matches for “' + escapeHtml(query) + '”. That gap may itself be the answer — check <a href="07-not-covered.html">Coverage</a>.</div>';
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
  }

  return {
    init: init,
    search: search,
    tokenize: tokenize,
    highlight: highlight,
    escapeHtml: escapeHtml,
    registerSearchable: registerSearchable,
    renderStaticFigure: renderStaticFigure,
    renderMermaidFigure: renderMermaidFigure,
    renderChartFigure: renderChartFigure,
    svg: {
      ideaPipeline: ideaPipeline,
      componentLayers: componentLayers,
      architectureLayers: architectureLayers,
      stepsRibbon: stepsRibbon,
      phaseTimeline: phaseTimeline,
      assumptionsRibbon: assumptionsRibbon,
      coverageGrid: coverageGrid,
      openQuestionFork: openQuestionFork
    }
  };
})();
