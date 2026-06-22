# numbl-mip-ci

Continuously checks that every package in the [`mip-org/core`](https://github.com/mip-org/mip-core)
channel works under [numbl](https://github.com/flatironinstitute/numbl).

For each package, a GitHub Action runs the full mip lifecycle inside a single
numbl process:

```
mip install --channel mip-org/core <pkg>
mip load <pkg>
mip test <pkg>
mip unload <pkg>
mip uninstall <pkg>
```

The results are classified, written to `report.json`, and published to GitHub
Pages as an interactive table. **[View the report &rarr;](https://magland.github.io/numbl-mip-ci/)**

## How it works

- numbl is built fresh from the `main` branch of `flatironinstitute/numbl` on
  every run, so the report always reflects the latest numbl.
- The package list comes from `mip avail` (the live channel index).
- Each package runs in its own numbl process via [`scripts/driver.m`](scripts/driver.m),
  which emits machine-readable `@@STEP_*` markers. Load state is in-process, so
  the whole lifecycle must share one process.
- [`scripts/run-tests.mjs`](scripts/run-tests.mjs) spawns the driver per
  package (with a per-package timeout), parses the markers and interleaved
  output, classifies the outcome, and writes the report.
- If `install` fails there is nothing to load/test/uninstall, so the remaining
  steps are skipped.
- The `mip` package itself is excluded (running `mip test mip` inside the same
  process is recursive). Adjust with `--skip`.

## Outcome categories

| category | meaning |
| --- | --- |
| `ok` | all steps passed (`no test` flag if the package defines no test script) |
| `test_failed` | install/load succeeded but the package's test script errored |
| `install_error` | install failed (download, dependency, build, …) |
| `arch_unavailable` | no build for `numbl_linux_x86_64` (e.g. native-only MEX) |
| `load_error` / `unload_error` / `uninstall_error` | the corresponding step errored |
| `timeout` | the package exceeded the per-package time limit |
| `crash` | the numbl process died without completing the lifecycle |

The captured error identifier (e.g. `mip:test:failed`), message, and per-step
output are kept in the report for diagnosis.

## The report

`report.json` shape:

```jsonc
{
  "generatedAt": "2026-...",
  "channel": "mip-org/core",
  "arch": "numbl_linux_x86_64",
  "numbl": { "version": "0.4.x", "commit": "…", "ref": "main" },
  "steps": ["install", "load", "test", "unload", "uninstall"],
  "summary": { "total": 42, "ok": 20, "byCategory": { "ok": 20, "test_failed": 14, … } },
  "packages": [
    {
      "name": "chebfun",
      "category": "ok",
      "ok": true,
      "failingStep": null,
      "errorId": null,
      "errorMessage": null,
      "durationMs": 1234,
      "steps": [ { "name": "install", "status": "ok", "ms": 500, "log": "…" }, … ],
      "log": "…"
    }
  ]
}
```

Each run pushes the site (including `report.json`) to the `gh-pages` branch and
keeps a timestamped copy under `reports/` for history.

## Triggers

Daily (07:00 UTC), on push to `main`, and on demand:

```bash
gh workflow run test.yml
```

## Running locally

```bash
# build numbl somewhere, then:
node scripts/run-tests.mjs \
  --numbl /path/to/numbl/dist-cli/cli.js \
  --out site/report.json

# test a subset:
node scripts/run-tests.mjs --numbl … --packages chebfun,chunkie --out /tmp/r.json

# preview the site:
cd site && python3 -m http.server
```
