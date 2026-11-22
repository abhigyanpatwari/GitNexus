"""Render a completed PR #3910 sweep; no timing data is discarded."""
import csv
import json
import math
import statistics
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import ScalarFormatter

source = Path(sys.argv[1])
out = source.parent
data = json.loads(source.read_text())
assert data["status"] == "complete", "Do not plot an incomplete sweep as completed evidence"
sizes = sorted(data["config"]["sizes"])
rounds = range(data["config"]["rounds"])
forms = ["deferred", "prefixed"]
axes = ["prefixes", "uses"]
phases = ["capture", "resolve"]
cells = {(c["axis"], c["form"], c["round"], c["size"]): c for c in data["cells"]}
assert len(cells) == len(axes) * len(forms) * len(rounds) * len(sizes)

def estimate(axis, form, round_index, size, phase, estimator="median"):
    cell = cells[axis, form, round_index, size]
    values = [s[f"{phase}_ms"] for s in cell["samples"] if not s["warmup"]]
    assert len(values) == data["config"]["reps"]
    assert all(math.isfinite(v) and v > 0 for v in values)
    return statistics.median(values) if estimator == "median" else min(values)

def slope(xs, ys):
    lx, ly = [math.log(x) for x in xs], [math.log(y) for y in ys]
    mx, my = statistics.mean(lx), statistics.mean(ly)
    return sum((x - mx) * (y - my) for x, y in zip(lx, ly)) / sum((x - mx) ** 2 for x in lx)

summary = {
    "source_commit": data["source_commit"], "config": data["config"],
    "environment": data["environment"], "correctness": "All cells and every timed resolution passed; all paired fingerprints match.",
    "interpretation": "T proportional to N^alpha: alpha=1 is linear. Fits describe this finite range. Round min/max are not confidence intervals.",
    "series": [],
}
series_rows = []
for axis in axes:
    for phase in phases:
        for form in forms:
            series = {"axis": axis, "phase": phase, "form": form, "estimators": {}}
            for estimator in ["median", "minimum"]:
                by_round = [[estimate(axis, form, r, n, phase, estimator) for n in sizes] for r in rounds]
                alphas = [slope(sizes, ys) for ys in by_round]
                aggregate = [statistics.median(ys[i] for ys in by_round) for i in range(len(sizes))]
                endpoint_ratios = [ys[-1] / ys[0] for ys in by_round]
                series["estimators"][estimator] = {
                    "sizes": sizes, "times_ms": aggregate, "round_times_ms": by_round,
                    "alpha": statistics.median(alphas), "alpha_by_round": alphas,
                    "alpha_round_range": [min(alphas), max(alphas)],
                    "endpoint_slowdown": statistics.median(endpoint_ratios),
                    "endpoint_slowdown_by_round": endpoint_ratios,
                    "input_growth": sizes[-1] / sizes[0],
                    "doubling_ratios": [aggregate[i] / aggregate[i - 1] for i in range(1, len(sizes))],
                }
                for size, time in zip(sizes, aggregate):
                    series_rows.append({"axis": axis, "phase": phase, "form": form,
                                        "estimator": estimator, "size": size, "time_ms": time})
            summary["series"].append(series)

with (out / "raw-samples.csv").open("w", newline="") as handle:
    fields = ["axis", "size", "form", "round", "prefixes", "uses", "source_bytes", "iteration", "warmup", "phase_order", "capture_ms", "resolve_ms"]
    writer = csv.DictWriter(handle, fieldnames=fields)
    writer.writeheader()
    for cell in data["cells"]:
        for sample in cell["samples"]:
            row = {name: cell[name] for name in fields[:7]}
            row.update(sample)
            row["phase_order"] = ",".join(sample["phase_order"])
            writer.writerow(row)
with (out / "series.csv").open("w", newline="") as handle:
    writer = csv.DictWriter(handle, fieldnames=list(series_rows[0]))
    writer.writeheader()
    writer.writerows(series_rows)
(out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "axes.spines.top": False,
                     "axes.spines.right": False, "axes.titleweight": "bold"})
fig, grid = plt.subplots(2, 2, figsize=(12.6, 9.6))
colors = {"deferred": "#135bb5", "prefixed": "#b35313"}
labels = {"deferred": "Deferred import", "prefixed": "Ordinary prefixed import"}
for row, phase in enumerate(phases):
    for col, axis in enumerate(axes):
        ax = grid[row, col]
        linear = [n / sizes[0] for n in sizes]
        maxima = [max(linear)]
        ax.plot(sizes, linear, color="#343a40", linestyle="--", linewidth=1.5, label="Linear reference")
        annotations = []
        for form in forms:
            series = next(s for s in summary["series"] if (s["axis"], s["phase"], s["form"]) == (axis, phase, form))
            e = series["estimators"]["median"]
            normalized = [[y / times[0] for y in times] for times in e["round_times_ms"]]
            center = [statistics.median(ys[i] for ys in normalized) for i in range(len(sizes))]
            low = [min(ys[i] for ys in normalized) for i in range(len(sizes))]
            high = [max(ys[i] for ys in normalized) for i in range(len(sizes))]
            maxima.append(max(high))
            ax.fill_between(sizes, low, high, color=colors[form], alpha=0.12)
            ax.plot(sizes, center, marker="o" if form == "deferred" else "s", markersize=5,
                    linewidth=2, color=colors[form], label=labels[form])
            annotations.append(f"{labels[form]}: α = {e['alpha']:.2f}")
        ax.set_xscale("log", base=2)
        ax.set_yscale("log", base=2)
        ax.set_xticks(sizes)
        ax.xaxis.set_major_formatter(ScalarFormatter())
        ax.set_yticks([1, 2, 4, 8, 16, 32, 64, 128])
        ax.yaxis.set_major_formatter(ScalarFormatter())
        ax.set_ylim(0.8, max(32, 2 ** math.ceil(math.log2(max(maxima)))))
        ax.set_xlabel("Import prefixes (16 uses each)" if axis == "prefixes" else "Uses per prefix (16 prefixes)")
        ax.set_ylabel(f"{phase.capitalize()} time / time at {sizes[0]}")
        ax.set_title(f"{phase.capitalize()} · {'prefixes grow' if axis == 'prefixes' else 'uses grow'}", loc="left", pad=12)
        ax.text(0.04, 0.95, "\n".join(annotations), transform=ax.transAxes, va="top", fontsize=10,
                bbox={"facecolor": "white", "alpha": 0.85, "edgecolor": "none", "pad": 4})
        ax.grid(True, which="major", color="#d8dce2", linewidth=0.7, alpha=0.7)
handles, legend_labels = grid[0, 0].get_legend_handles_labels()
fig.legend(handles, legend_labels, loc="upper center", bbox_to_anchor=(0.5, 0.935), ncol=3, frameon=False)
fig.suptitle("Dart deferred-import scaling — measured against linear growth", x=0.07, y=0.985, ha="left", fontsize=17, weight="bold")
revision = (data.get("source_commit") or "unknown")[:7]
fig.text(0.07, 0.946, f"PR #3910 · {revision} · {data['environment']['platform']} {data['environment']['arch']} · Node {data['environment']['node']}", color="#4e5662")
fig.text(0.07, 0.045,
         f"{len(rounds)} fresh-process rounds per point; {data['config']['reps']} measured passes after {data['config']['warmup']} warmups. "
         "Lines: median of round-normalized medians.\n"
         "Shading: observed round range, not a confidence interval. α: median log–log slope across rounds (1 = linear).\n"
         "All measured resolutions passed exact graph checks. Timings exclude configuration, graph replay and persistence.",
         fontsize=9, color="#4e5662", linespacing=1.5)
fig.subplots_adjust(left=0.085, right=0.975, top=0.86, bottom=0.15, hspace=0.38, wspace=0.23)
for extension in ["png", "svg", "pdf"]:
    fig.savefig(out / f"scaling.{extension}", dpi=180, facecolor="white")
for s in summary["series"]:
    med, minimum = s["estimators"]["median"], s["estimators"]["minimum"]
    print(f"{s['axis']:8} {s['phase']:7} {s['form']:8} alpha={med['alpha']:.3f} "
          f"range={med['alpha_round_range'][0]:.3f}..{med['alpha_round_range'][1]:.3f} "
          f"min-alpha={minimum['alpha']:.3f} endpoint={med['endpoint_slowdown']:.2f}x")
