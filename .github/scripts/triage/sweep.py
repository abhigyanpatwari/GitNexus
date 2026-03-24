"""Triage sweep: fetch open issues/PRs, detect outliers and duplicates, generate a report.

Entrypoint script for the triage-sweep workflow. Fetches all open items via
the GitHub REST API, delegates embedding and analysis to embedding_utils,
generates a markdown report, and optionally creates a report issue.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.parse
from typing import TypedDict
from datetime import datetime, timezone

from embedding_utils import (
    embed_texts,
    normalize_rows,
    reduce_dimensions,
    detect_outliers,
    find_duplicate_pairs,
    suggest_labels,
    LABEL_Z_THRESHOLD,
    LABEL_Z_MARGIN,
    LABEL_Z_STD_FLOOR,
    MIN_RAW_SIMILARITY,
    MAX_LABELS_PER_ITEM,
)

# ── Thresholds (overridable via workflow_dispatch inputs) ──────────────

# IQR multiplier for outlier cutoff: cutoff = Q75 + IQR_MULTIPLIER * IQR.
IQR_MULTIPLIER: float = float(os.environ.get("INPUT_IQR_MULTIPLIER", "3.0"))

# Hard cap: at most this fraction of items can be flagged as outliers.
MAX_OUTLIER_PCT: float = float(os.environ.get("INPUT_MAX_OUTLIER_PCT", "0.05"))

# EllipticEnvelope contamination: expected fraction of outliers in the data.
# Governs how aggressively the robust covariance downweights extreme points.
CONTAMINATION: float = float(os.environ.get("INPUT_CONTAMINATION", "0.1"))

# Cosine similarity above which two items are flagged as duplicates.
# 0.92 catches near-identical issues while tolerating paraphrasing.
COSINE_THRESHOLD: float = float(os.environ.get("INPUT_COSINE_THRESHOLD", "0.92"))

# Hard cap on items to process. Prevents runaway costs on very large repos.
MAX_ITEMS: int = int(os.environ.get("INPUT_MAX_ITEMS", "500"))

# When true, print report to stdout/file but do not create a GitHub issue.
DRY_RUN: bool = os.environ.get("INPUT_DRY_RUN", "false").lower() == "true"

# ── Fixed constants (not user-configurable) ───────────────────────────

# Minimum number of samples required for EllipticEnvelope to fit
# a Gaussian reliably. Must be >= 3 * PCA_MAX_COMPONENTS so the
# covariance matrix is estimated from enough data points.
PCA_MAX_COMPONENTS: int = 20
MIN_SAMPLES_FOR_OUTLIER_DETECTION: int = 100

# Max character length for embedding input text. bge-small-en-v1.5 has a
# 512-token context window (~4 chars/token). We keep title + body under
# this limit so the model sees the full text instead of silently truncating.
MAX_EMBED_CHARS: int = 2000

# GitHub REST API page size (max allowed is 100).
API_PAGE_SIZE: int = 100

# Report issue label.
REPORT_LABEL: str = "triage-report"

# Report file path (written for the summary step to pick up).
REPORT_FILE: str = "/tmp/triage-report.md"


class TriageItem(TypedDict):
    """One open issue or PR, with only the fields we need."""
    number: int
    title: str
    html_url: str
    is_pr: bool
    labels: list[str]
    created_at: str
    # title + body concatenated, used as embedding input
    text: str


def github_api_get(path: str) -> list[dict]:
    """Make a single authenticated GET request to the GitHub REST API.

    Reads GITHUB_TOKEN and GITHUB_REPOSITORY from env. Raises SystemExit
    with the HTTP status and response body on any non-2xx response.
    """
    token = os.environ["GITHUB_TOKEN"]
    repo = os.environ["GITHUB_REPOSITORY"]
    url = f"https://api.github.com/repos/{repo}{path}"

    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"::error::GitHub API {e.code}: {body}")
        sys.exit(1)


def fetch_all_open_items() -> list[TriageItem]:
    """Paginate through all open issues and PRs.

    Returns up to MAX_ITEMS TriageItem dicts. Items with a pull_request
    key are marked is_pr=True. The text field is title + body concatenated.
    """
    items: list[TriageItem] = []
    page = 1

    while len(items) < MAX_ITEMS:
        path = (
            f"/issues?state=open&per_page={API_PAGE_SIZE}"
            f"&sort=created&direction=desc&page={page}"
        )
        data = github_api_get(path)

        if not data:
            break

        for raw in data:
            if len(items) >= MAX_ITEMS:
                break

            body = raw.get("body", "") or ""
            full_text = f"{raw['title']}\n\n{body}"
            # Truncate to fit the embedding model's token window.
            # Title is always preserved; body gets clipped if needed.
            if len(full_text) > MAX_EMBED_CHARS:
                full_text = full_text[:MAX_EMBED_CHARS]
            items.append(TriageItem(
                number=raw["number"],
                title=raw["title"],
                html_url=raw["html_url"],
                is_pr="pull_request" in raw,
                labels=[lbl["name"] for lbl in raw.get("labels", [])],
                created_at=raw["created_at"],
                text=full_text,
            ))

        if len(data) < API_PAGE_SIZE:
            break

        page += 1

    return items


class RepoLabel(TypedDict):
    """A label from the repo with its embedding text."""
    name: str
    description: str
    # "name: description" concatenated for embedding
    text: str


def fetch_repo_labels() -> list[RepoLabel]:
    """Fetch all labels from the repository, paginating if needed.

    Returns labels with name, description, and a text field suitable
    for embedding ("name: description"). Labels with no description
    use just the name.
    """
    labels: list[RepoLabel] = []
    page = 1

    while True:
        data = github_api_get(f"/labels?per_page={API_PAGE_SIZE}&page={page}")
        for raw in data:
            name = raw["name"]
            desc = raw.get("description", "") or ""
            text = f"{name}: {desc}" if desc else name
            labels.append(RepoLabel(name=name, description=desc, text=text))

        if len(data) < API_PAGE_SIZE:
            break
        page += 1

    return labels


def apply_labels_to_item(item_number: int, labels: list[str]) -> None:
    """Add labels to a single issue/PR via the GitHub API.

    Skips silently if labels list is empty. Uses POST which adds labels
    without removing existing ones.
    """
    if not labels:
        return

    token = os.environ["GITHUB_TOKEN"]
    repo = os.environ["GITHUB_REPOSITORY"]
    url = f"https://api.github.com/repos/{repo}/issues/{item_number}/labels"

    payload = json.dumps({"labels": labels}).encode("utf-8")
    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        # Non-fatal: log warning but don't abort the sweep
        print(f"::warning::Failed to label #{item_number}: {e.code} {body}")


def _item_age(created_at: str) -> str:
    """Compute a human-readable age string from an ISO 8601 created_at timestamp."""
    try:
        created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        delta = datetime.now(timezone.utc) - created
        days = delta.days
        if days < 1:
            return "<1d"
        if days < 30:
            return f"{days}d"
        if days < 365:
            return f"{days // 30}mo"
        return f"{days // 365}y"
    except (ValueError, TypeError):
        return "?"


def _suggested_action(a: TriageItem, b: TriageItem) -> str:
    """Determine a suggested action for a duplicate pair based on types and age."""
    if a["is_pr"] and b["is_pr"]:
        return "Review for overlap"
    if not a["is_pr"] and not b["is_pr"]:
        # Both issues — close the newer one
        try:
            a_dt = datetime.fromisoformat(a["created_at"].replace("Z", "+00:00"))
            b_dt = datetime.fromisoformat(b["created_at"].replace("Z", "+00:00"))
            newer = b if b_dt > a_dt else a
        except (ValueError, TypeError):
            newer = b
        return f"Close #{newer['number']} as duplicate"
    # One issue, one PR
    return "Link PR to issue"


def generate_report(
    items: list[TriageItem],
    outlier_results: list[tuple[int, float]],
    duplicate_pairs: list[tuple[int, int, float]],
    label_suggestions: list[list[tuple[str, float]]] | None = None,
) -> str:
    """Generate a structured markdown triage report."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    repo = os.environ.get("GITHUB_REPOSITORY", "unknown/repo")

    # Compute label suggestion counts early for the health table
    outlier_set = {idx for idx, _ in outlier_results}
    suggested_count = 0
    if label_suggestions is not None:
        suggested_count = sum(
            1 for i, s in enumerate(label_suggestions)
            if s and not items[i]["labels"] and i not in outlier_set
        )

    # ── Health summary table at the top ──────────────────────────────
    lines: list[str] = [
        "## Triage Sweep Report",
        "",
        f"**Run:** {now} UTC",
        f"**Items analyzed:** {len(items)}",
        f"**Thresholds:** IQR multiplier {IQR_MULTIPLIER}, Cosine > {COSINE_THRESHOLD}",
        "",
        "### Health Summary",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Items analyzed | {len(items)} |",
        f"| Outliers flagged | {len(outlier_results)} |",
        f"| Duplicate pairs | {len(duplicate_pairs)} |",
        f"| Label suggestions | {suggested_count} |",
        "",
    ]

    # ── Outlier section ──────────────────────────────────────────────
    # Determine cutoff for high-confidence split
    cutoff = getattr(outlier_results, "cutoff", 0.0)
    high_conf_cutoff = 2 * cutoff if cutoff > 0 else float("inf")

    high_conf = [(idx, d) for idx, d in outlier_results if d > high_conf_cutoff]
    borderline = [(idx, d) for idx, d in outlier_results if d <= high_conf_cutoff]

    lines.extend([
        f"### Potential Outliers / Spam ({len(outlier_results)})",
        "",
        "Items with unusually high Mahalanobis distance from the distribution center.",
        "These may be spam, off-topic, or poorly described.",
        "",
    ])

    if high_conf:
        lines.append(f"**High Confidence** ({len(high_conf)} items, distance > 2x cutoff)")
        lines.append("")
        lines.append("| # | Type | Title | Distance | Age |")
        lines.append("|---|------|-------|----------|-----|")
        for idx, distance in high_conf:
            item = items[idx]
            kind = "PR" if item["is_pr"] else "Issue"
            age = _item_age(item["created_at"])
            title = item["title"][:80] + ("..." if len(item["title"]) > 80 else "")
            lines.append(
                f"| [#{item['number']}]({item['html_url']}) "
                f"| {kind} | {title} | {distance:.2f} | {age} |"
            )
        lines.append("")

    if borderline:
        lines.append("<details>")
        lines.append(f"<summary>Borderline ({len(borderline)} items)</summary>")
        lines.append("")
        lines.append("| # | Type | Title | Distance | Age |")
        lines.append("|---|------|-------|----------|-----|")
        for idx, distance in borderline:
            item = items[idx]
            kind = "PR" if item["is_pr"] else "Issue"
            age = _item_age(item["created_at"])
            title = item["title"][:80] + ("..." if len(item["title"]) > 80 else "")
            lines.append(
                f"| [#{item['number']}]({item['html_url']}) "
                f"| {kind} | {title} | {distance:.2f} | {age} |"
            )
        lines.append("")
        lines.append("</details>")
        lines.append("")

    if not outlier_results:
        lines.append("None found.")

    # ── Duplicate pairs section ──────────────────────────────────────
    lines.extend([
        "",
        f"### Potential Duplicates ({len(duplicate_pairs)} pairs)",
        "",
        "Pairs of items with cosine similarity above the threshold.",
        "",
    ])

    if duplicate_pairs:
        lines.append("| Item A | Item B | Similarity | Suggested Action |")
        lines.append("|--------|--------|------------|------------------|")
        for i, j, sim in duplicate_pairs:
            a = items[i]
            b = items[j]
            kind_a = "PR" if a["is_pr"] else "Issue"
            kind_b = "PR" if b["is_pr"] else "Issue"
            action = _suggested_action(a, b)
            lines.append(
                f"| [#{a['number']}]({a['html_url']}) {kind_a}: {a['title']} "
                f"| [#{b['number']}]({b['html_url']}) {kind_b}: {b['title']} "
                f"| {sim:.3f} | {action} |"
            )
    else:
        lines.append("None found.")

    # ── Label suggestions section ────────────────────────────────────
    if label_suggestions is not None:
        # High confidence: top-1 label with raw_sim >= 0.5
        # Low confidence: top-1 label with raw_sim < 0.5
        high_conf_labels: list[tuple[int, list[tuple[str, float]]]] = []
        low_conf_labels: list[tuple[int, list[tuple[str, float]]]] = []
        for i, sugs in enumerate(label_suggestions):
            if sugs and not items[i]["labels"] and i not in outlier_set:
                top1 = sugs[:1]
                if top1[0][1] >= 0.5:
                    high_conf_labels.append((i, top1))
                else:
                    low_conf_labels.append((i, top1))

        total_suggestions = len(high_conf_labels) + len(low_conf_labels)
        lines.extend([
            "",
            f"### Suggested Labels ({total_suggestions} unlabeled items)",
            "",
            "Labels suggested by z-score normalized embedding similarity against repo label descriptions.",
            "Only shown for unlabeled items that were not flagged as outliers.",
            "",
        ])

        # Label concentration warning
        if total_suggestions > 0:
            label_counts: dict[str, int] = {}
            for _, sugs in high_conf_labels + low_conf_labels:
                for name, _ in sugs:
                    label_counts[name] = label_counts.get(name, 0) + 1
            for name, count in label_counts.items():
                if count > total_suggestions * 0.5:
                    lines.append(
                        f"> **Warning:** Label `{name}` accounts for "
                        f"{count}/{total_suggestions} suggestions "
                        f"({count * 100 // total_suggestions}%). "
                        f"Consider reviewing label descriptions for specificity."
                    )
                    lines.append("")

        if high_conf_labels:
            lines.append("| # | Type | Title | Suggested Label |")
            lines.append("|---|------|-------|--------------------|")
            for idx, sugs in high_conf_labels:
                item = items[idx]
                kind = "PR" if item["is_pr"] else "Issue"
                label_strs = [f"`{name}` ({score:.2f})" for name, score in sugs]
                lines.append(
                    f"| [#{item['number']}]({item['html_url']}) "
                    f"| {kind} | {item['title']} | {', '.join(label_strs)} |"
                )

        if low_conf_labels:
            lines.append("")
            lines.append("<details>")
            lines.append(f"<summary>Low-confidence suggestions ({len(low_conf_labels)} items)</summary>")
            lines.append("")
            lines.append("| # | Type | Title | Suggested Label |")
            lines.append("|---|------|-------|--------------------|")
            for idx, sugs in low_conf_labels:
                item = items[idx]
                kind = "PR" if item["is_pr"] else "Issue"
                label_strs = [f"`{name}` ({score:.2f})" for name, score in sugs]
                lines.append(
                    f"| [#{item['number']}]({item['html_url']}) "
                    f"| {kind} | {item['title']} | {', '.join(label_strs)} |"
                )
            lines.append("")
            lines.append("</details>")

        if not high_conf_labels and not low_conf_labels:
            lines.append("No unlabeled items need suggestions.")

    lines.extend([
        "",
        "### Summary",
        "",
        f"- {len(outlier_results)} outliers flagged for review",
        f"- {len(duplicate_pairs)} duplicate pairs found",
        f"- {len(items)} items analyzed in total",
    ])

    if label_suggestions is not None:
        lines.append(f"- {suggested_count} items suggested for labeling")

    lines.extend([
        "",
        "---",
        f"*Generated by [triage-sweep](https://github.com/{repo}/actions) — no LLM was used.*",
    ])

    return "\n".join(lines)


def create_report_issue(report_body: str) -> None:
    """Create a GitHub issue with the triage report.

    Posts to the issues API with the triage-report label.
    Raises SystemExit on non-201 response.
    """
    token = os.environ["GITHUB_TOKEN"]
    repo = os.environ["GITHUB_REPOSITORY"]
    url = f"https://api.github.com/repos/{repo}/issues"

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    payload = json.dumps({
        "title": f"Triage Sweep Report — {today}",
        "body": report_body,
        "labels": [REPORT_LABEL],
    }).encode("utf-8")

    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp_body = resp.read().decode("utf-8")
            if resp.status != 201:
                print(f"::error::Failed to create issue: {resp.status} {resp_body}")
                sys.exit(1)
            result = json.loads(resp_body)
            print(f"Created issue: {result.get('html_url', 'unknown')}")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"::error::Failed to create issue: {e.code} {body}")
        sys.exit(1)


def write_report(report: str) -> None:
    """Write the report to the file system for the summary step."""
    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        f.write(report)


def main() -> None:
    """Orchestrate the full triage sweep."""
    # 1. Validate environment
    for var in ("GITHUB_TOKEN", "GITHUB_REPOSITORY"):
        if not os.environ.get(var):
            print(f"::error::Missing required environment variable: {var}")
            sys.exit(1)

    # 2. Fetch all open issues + PRs
    items = fetch_all_open_items()
    print(f"Fetched {len(items)} open items")

    if len(items) == 0:
        report = "## Triage Sweep Report\n\nNo open issues or PRs found."
        write_report(report)
        print("No items to analyze.")
        return

    # 3. Extract texts for embedding
    texts: list[str] = [item["text"] for item in items]

    # 4. Embed all texts (returns numpy float32 array of shape [n, 384])
    embeddings = embed_texts(texts)

    # 5. L2-normalize
    embeddings = normalize_rows(embeddings)

    # 6. Outlier detection (Mahalanobis via EllipticEnvelope)
    outlier_results: list[tuple[int, float]] = []
    if len(items) >= MIN_SAMPLES_FOR_OUTLIER_DETECTION:
        reduced = reduce_dimensions(embeddings, PCA_MAX_COMPONENTS)
        outlier_results = detect_outliers(
            reduced,
            contamination=CONTAMINATION,
            iqr_multiplier=IQR_MULTIPLIER,
            max_outlier_pct=MAX_OUTLIER_PCT,
        )
    else:
        print(
            f"Skipping outlier detection: {len(items)} items < "
            f"{MIN_SAMPLES_FOR_OUTLIER_DETECTION} minimum"
        )

    # 7. Duplicate detection (pairwise cosine similarity)
    duplicate_pairs = find_duplicate_pairs(embeddings, COSINE_THRESHOLD)

    # 8. Label suggestion via embedding similarity
    label_suggestions: list[list[tuple[str, float]]] | None = None
    repo_labels = fetch_repo_labels()
    if repo_labels:
        label_texts = [lbl["text"] for lbl in repo_labels]
        label_names = [lbl["name"] for lbl in repo_labels]
        label_embeddings = embed_texts(label_texts)
        label_embeddings = normalize_rows(label_embeddings)
        label_suggestions = suggest_labels(embeddings, label_embeddings, label_names)
        print(f"Computed label suggestions against {len(repo_labels)} repo labels")

        # NOTE: Auto-labeling is disabled. The report shows suggestions for
        # human review. To re-enable, uncomment the block below.
        #
        # # Apply top label to unlabeled items (unless dry run)
        # # Skip outliers — flagged items shouldn't get categorized
        # outlier_set = {idx for idx, _ in outlier_results}
        # if not DRY_RUN:
        #     applied_count = 0
        #     for i, sugs in enumerate(label_suggestions):
        #         if sugs and not items[i]["labels"] and i not in outlier_set:
        #             # Apply only the top-1 label (highest confidence)
        #             apply_labels_to_item(items[i]["number"], [sugs[0][0]])
        #             applied_count += 1
        #     print(f"Applied labels to {applied_count} unlabeled items")
    else:
        print("No repo labels found — skipping label suggestions")

    # 9. Generate report
    report = generate_report(items, outlier_results, duplicate_pairs, label_suggestions)

    # 10. Write report to file (for summary step)
    write_report(report)

    # 11. Create report issue (unless dry run)
    if DRY_RUN:
        print("Dry run — skipping issue creation and label application.")
        print(report)
    else:
        create_report_issue(report)
        print("Report issue created.")


if __name__ == "__main__":
    main()
