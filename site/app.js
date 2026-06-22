"use strict";

const CATEGORY_LABELS = {
  ok: "ok",
  test_failed: "test failed",
  install_error: "install error",
  load_error: "load error",
  unload_error: "unload error",
  uninstall_error: "uninstall error",
  arch_unavailable: "arch unavailable",
  timeout: "timeout",
  crash: "crash",
  unknown: "unknown",
};

const CATEGORY_COLORS = {
  ok: "#2ea043",
  test_failed: "#d2353a",
  install_error: "#ff8a8d",
  load_error: "#ff8a8d",
  unload_error: "#ff8a8d",
  uninstall_error: "#ff8a8d",
  arch_unavailable: "#6e7681",
  timeout: "#d29922",
  crash: "#d2353a",
  unknown: "#d2353a",
};

let report = null;
let activeFilter = "all";

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function fmtMs(ms) {
  if (ms == null) return "";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(1) + " s";
}

function renderMeta() {
  const n = report.numbl || {};
  const when = report.generatedAt ? new Date(report.generatedAt).toLocaleString() : "unknown";
  const commit = n.commit ? n.commit.slice(0, 8) : "?";
  const meta = document.getElementById("meta");
  meta.innerHTML = "";
  meta.append(
    document.createTextNode(`Channel `),
    el("code", { text: report.channel || "?" }),
    document.createTextNode(` · arch `),
    el("code", { text: report.arch || "?" }),
    document.createTextNode(` · numbl `),
    el("code", { text: `${n.version || "?"} @ ${commit}` }),
    document.createTextNode(` · ${when}`)
  );
}

function renderSummary() {
  const wrap = document.getElementById("summary");
  wrap.innerHTML = "";
  const cats = report.summary.byCategory || {};
  const keys = Object.keys(cats).sort((a, b) => {
    if (a === "ok") return -1;
    if (b === "ok") return 1;
    return cats[b] - cats[a];
  });
  for (const k of keys) {
    const chip = el("span", { class: "chip" }, [
      el("span", { class: "dot" }),
      document.createTextNode(CATEGORY_LABELS[k] || k),
      el("span", { class: "count", text: String(cats[k]) }),
    ]);
    chip.querySelector(".dot").style.background = CATEGORY_COLORS[k] || "#888";
    wrap.appendChild(chip);
  }
}

function renderFilters() {
  const wrap = document.getElementById("filters");
  wrap.innerHTML = "";
  const cats = report.summary.byCategory || {};
  const opts = ["all", ...Object.keys(cats).sort()];
  for (const k of opts) {
    const label = k === "all" ? `all (${report.summary.total})` : `${CATEGORY_LABELS[k] || k} (${cats[k]})`;
    const btn = el("button", { class: k === activeFilter ? "active" : "", text: label });
    btn.onclick = () => {
      activeFilter = k;
      renderFilters();
      renderRows();
    };
    wrap.appendChild(btn);
  }
}

function stepCell(step) {
  if (!step) return el("td", { class: "cell s-missing", text: "—" });
  const sym = { ok: "✓", fail: "✕", skipped: "–", missing: "?", running: "…" }[step.status] || "?";
  const txt = step.status === "ok" && step.ms != null ? `${sym}` : sym;
  const td = el("td", { class: "cell s-" + step.status, text: txt });
  td.title = step.status + (step.errorId ? ` (${step.errorId})` : "") + (step.ms != null ? ` ${fmtMs(step.ms)}` : "");
  return td;
}

function detailRow(pkg) {
  const tr = el("tr", { class: "detail" });
  const td = el("td", { colspan: "8" });
  const inner = el("div", { class: "detail-inner" });

  if (pkg.errorId || pkg.errorMessage) {
    const err = el("p", { class: "err" });
    if (pkg.errorId) err.append(el("span", { class: "id", text: pkg.errorId }), document.createTextNode("  "));
    if (pkg.errorMessage) err.append(document.createTextNode(pkg.errorMessage));
    inner.appendChild(err);
  }

  const logs = el("div", { class: "step-logs" });
  for (const step of pkg.steps) {
    if (!step.log || !step.log.trim()) continue;
    const block = el("div", { class: "step-block" }, [
      el("h4", { text: `${step.name} — ${step.status}${step.ms != null ? " (" + fmtMs(step.ms) + ")" : ""}` }),
      el("pre", { class: "log", text: step.log.trim() }),
    ]);
    logs.appendChild(block);
  }
  if (!logs.children.length) {
    logs.appendChild(el("pre", { class: "log", text: (pkg.log || "").trim() || "(no output)" }));
  }
  inner.appendChild(logs);
  td.appendChild(inner);
  tr.appendChild(td);
  return tr;
}

function renderRows() {
  const tbody = document.getElementById("rows");
  tbody.innerHTML = "";
  const pkgs = report.packages.filter((p) => activeFilter === "all" || p.category === activeFilter);
  if (!pkgs.length) {
    tbody.appendChild(el("tr", {}, el("td", { colspan: "8", class: "empty", text: "No packages match this filter." })));
    return;
  }
  for (const pkg of pkgs) {
    const badge = el("span", {
      class: "badge c-" + pkg.category,
      text: (CATEGORY_LABELS[pkg.category] || pkg.category) + (pkg.noTestScript ? " · no test" : ""),
    });
    const byName = Object.fromEntries(pkg.steps.map((s) => [s.name, s]));
    const row = el("tr", { class: "row" }, [
      el("td", { class: "pkg", text: pkg.name }),
      el("td", {}, badge),
      stepCell(byName.install),
      stepCell(byName.load),
      stepCell(byName.test),
      stepCell(byName.unload),
      stepCell(byName.uninstall),
      el("td", { class: "time", text: fmtMs(pkg.durationMs) }),
    ]);
    const detail = detailRow(pkg);
    detail.style.display = "none";
    row.onclick = () => {
      detail.style.display = detail.style.display === "none" ? "" : "none";
    };
    tbody.appendChild(row);
    tbody.appendChild(detail);
  }
}

async function main() {
  try {
    const resp = await fetch("report.json?t=" + Date.now());
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    report = await resp.json();
  } catch (err) {
    document.getElementById("meta").textContent = "Failed to load report.json: " + err.message;
    return;
  }
  renderMeta();
  renderSummary();
  renderFilters();
  renderRows();
}

main();
