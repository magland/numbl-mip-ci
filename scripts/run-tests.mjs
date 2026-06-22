#!/usr/bin/env node
// Orchestrator for numbl-mip-ci.
//
// For every package in the mip-org/core channel, run the full mip lifecycle
// (install -> load -> test -> unload -> uninstall) inside a single numbl
// process via scripts/driver.m, capture and classify the result, and write a
// JSON report.
//
// Usage:
//   node scripts/run-tests.mjs --numbl ./numbl/dist-cli/cli.js --out site/report.json
//
// Options:
//   --numbl <path>        Path to the built numbl cli.js (required)
//   --driver <path>       Path to driver.m (default: scripts/driver.m next to this file)
//   --out <path>          Output report path (default: site/report.json)
//   --packages a,b,c      Only test these packages (default: all from `mip avail`)
//   --skip a,b            Skip these packages (default: mip)
//   --limit <n>           Only test the first n packages (after sorting)
//   --timeout-ms <n>      Per-package timeout in ms (default: 600000)
//   --channel <name>      Channel (default: mip-org/core)

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STEPS = ["install", "load", "test", "unload", "uninstall"];
// Packages excluded by default. `mip` is the package manager itself — running
// `mip test mip` inside the same numbl process is recursive and hangs.
const DEFAULT_SKIP = ["mip"];

// ── arg parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const numblCli = args.numbl ? resolve(args.numbl) : null;
if (!numblCli) {
  console.error("ERROR: --numbl <path to cli.js> is required");
  process.exit(2);
}
const driverPath = resolve(args.driver || join(__dirname, "driver.m"));
const outPath = resolve(args.out || join(__dirname, "..", "site", "report.json"));
const channel = args.channel || "mip-org/core";
const timeoutMs = parseInt(args["timeout-ms"] || "600000", 10);
const limit = args.limit ? parseInt(args.limit, 10) : null;

// ── helpers ──────────────────────────────────────────────────────────────
function runNumbl(numblArgs, { env = {}, timeout } = {}) {
  // Synchronous one-shot used for quick metadata commands (e.g. mip avail).
  return spawnSync("node", [numblCli, ...numblArgs], {
    encoding: "utf8",
    timeout,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function getNumblVersion() {
  const r = runNumbl(["--version"], { timeout: 60000 });
  return (r.stdout || "").trim() || null;
}

function getNumblCommit() {
  // The numbl checkout is expected at ./numbl unless NUMBL_DIR is set.
  const dir = process.env.NUMBL_DIR || resolve(process.cwd(), "numbl");
  const r = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : process.env.NUMBL_COMMIT || null;
}

function getPackageList() {
  if (args.packages && args.packages !== "true") {
    return args.packages.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const r = runNumbl(["eval", "mip avail"], { timeout: 180000 });
  const text = (r.stdout || "") + (r.stderr || "");
  const names = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([\w.\-]+\/[\w.\-]+)\/([\w.\-]+)\s*$/);
    if (m) names.add(m[2]);
  }
  return [...names].sort();
}

// Run the driver for one package, capturing stdout+stderr in arrival order.
function runPackage(pkg) {
  return new Promise((res) => {
    const started = Date.now();
    const child = spawn("node", [numblCli, "run", driverPath], {
      env: { ...process.env, MIP_TEST_PACKAGE: pkg },
    });
    let log = "";
    let timedOut = false;
    const append = (buf) => {
      log += buf.toString();
      if (log.length > 4 * 1024 * 1024) log = log.slice(-4 * 1024 * 1024);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      res({
        log,
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      res({
        log: log + `\n[spawn error] ${err.message}`,
        exitCode: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

// Parse driver markers + interleaved output into per-step records.
function parseSteps(log) {
  const lines = log.split("\n");
  const steps = new Map(); // name -> record
  let cur = null;
  let sawAllDone = false;

  for (const line of lines) {
    let m;
    if ((m = line.match(/^@@STEP_BEGIN (\w+)/))) {
      cur = { name: m[1], status: "running", ms: null, errorId: null, errorMessage: null, log: "" };
      steps.set(m[1], cur);
    } else if ((m = line.match(/^@@STEP_END (\w+) status=(\w+) ms=(\d+)(?: id=(\S*) msg=(.*))?$/))) {
      const rec = steps.get(m[1]) || { name: m[1], log: "" };
      rec.status = m[2];
      rec.ms = parseInt(m[3], 10);
      if (m[2] === "fail") {
        rec.errorId = m[4] || "";
        rec.errorMessage = (m[5] || "").trim();
      }
      steps.set(m[1], rec);
      cur = null;
    } else if ((m = line.match(/^@@STEP_SKIP (\w+) reason=(\S+)/))) {
      steps.set(m[1], { name: m[1], status: "skipped", ms: null, errorId: null, errorMessage: null, reason: m[2], log: "" });
      cur = null;
    } else if (line.startsWith("@@ALL_DONE")) {
      sawAllDone = true;
    } else if (cur) {
      cur.log += line + "\n";
    }
  }

  // Normalize: ensure all steps present, in canonical order.
  const ordered = STEPS.map(
    (name) => steps.get(name) || { name, status: "missing", ms: null, errorId: null, errorMessage: null, log: "" }
  );
  return { steps: ordered, sawAllDone };
}

// Classify a package run into a single top-level category.
function classify({ steps, sawAllDone }, proc) {
  const result = {
    category: "ok",
    ok: false,
    failingStep: null,
    errorId: null,
    errorMessage: null,
    noTestScript: false,
  };

  if (proc.timedOut) {
    result.category = "timeout";
    return result;
  }

  const failing = steps.find((s) => s.status === "fail");

  // Process died without finishing and no clean step-level failure recorded.
  if (!sawAllDone && !failing) {
    result.category = "crash";
    return result;
  }

  if (failing) {
    result.failingStep = failing.name;
    result.errorId = failing.errorId;
    result.errorMessage = failing.errorMessage;
    switch (failing.name) {
      case "install":
        result.category =
          failing.errorId === "mip:packageUnavailable" ? "arch_unavailable" : "install_error";
        break;
      case "load":
        result.category = "load_error";
        break;
      case "test":
        result.category = "test_failed";
        break;
      case "unload":
        result.category = "unload_error";
        break;
      case "uninstall":
        result.category = "uninstall_error";
        break;
      default:
        result.category = "unknown";
    }
    return result;
  }

  // No failure: detect "no test script defined" note.
  const testStep = steps.find((s) => s.name === "test");
  if (testStep && /No test script defined/i.test(testStep.log)) {
    result.noTestScript = true;
  }
  result.ok = true;
  result.category = "ok";
  return result;
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  const skip = new Set(
    (args.skip && args.skip !== "true" ? args.skip.split(",").map((s) => s.trim()) : DEFAULT_SKIP).filter(Boolean)
  );
  const packages = getPackageList().filter((p) => !skip.has(p));
  const selected = limit ? packages.slice(0, limit) : packages;
  console.error(`Testing ${selected.length} package(s) from ${channel}` + (skip.size ? ` (skipping: ${[...skip].join(", ")})` : ""));

  const numblVersion = getNumblVersion();
  const numblCommit = getNumblCommit();

  const results = [];
  for (let i = 0; i < selected.length; i++) {
    const pkg = selected[i];
    process.stderr.write(`[${i + 1}/${selected.length}] ${pkg} ... `);
    const proc = await runPackage(pkg);
    const parsed = parseSteps(proc.log);
    const cls = classify(parsed, proc);
    console.error(cls.ok ? "ok" : cls.category);

    results.push({
      name: pkg,
      category: cls.category,
      ok: cls.ok,
      noTestScript: cls.noTestScript,
      failingStep: cls.failingStep,
      errorId: cls.errorId,
      errorMessage: cls.errorMessage,
      durationMs: proc.durationMs,
      timedOut: proc.timedOut,
      exitCode: proc.exitCode,
      steps: parsed.steps,
      log: proc.log.slice(-60000),
    });
  }

  const byCategory = {};
  for (const r of results) byCategory[r.category] = (byCategory[r.category] || 0) + 1;

  const report = {
    generatedAt: new Date().toISOString(),
    channel,
    arch: "numbl_linux_x86_64",
    numbl: { version: numblVersion, commit: numblCommit, ref: process.env.NUMBL_REF || "main" },
    skipped: [...skip].sort(),
    steps: STEPS,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      byCategory,
    },
    packages: results,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.error(`\nWrote ${outPath}`);
  console.error(`Summary: ${report.summary.ok}/${report.summary.total} ok`);
  console.error(JSON.stringify(byCategory));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
