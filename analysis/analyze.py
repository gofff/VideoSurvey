from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path


def wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> tuple[float, float]:
    if total <= 0:
        return (float("nan"), float("nan"))
    p = successes / total
    denom = 1.0 + (z * z) / total
    center = (p + (z * z) / (2.0 * total)) / denom
    margin = (z / denom) * math.sqrt((p * (1.0 - p) / total) + (z * z) / (4.0 * total * total))
    return (max(0.0, center - margin), min(1.0, center + margin))


def expected_choice(trial_type: str | None) -> str | None:
    if trial_type == "obvious_low":
        return "baseline"
    if trial_type == "same_same":
        return "nodiff"
    return None


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                rows.append(obj)
    return rows


def passed_attention(all_rows: list[dict]) -> set[str]:
    checks_by_participant: dict[str, list[bool]] = defaultdict(list)
    for r in all_rows:
        participant_id = r.get("participant_id")
        if not isinstance(participant_id, str):
            continue
        trial_type = r.get("trial_type")
        expected = r.get("expected_choice") or expected_choice(trial_type)
        if expected is None:
            continue
        checks_by_participant[participant_id].append(r.get("choice") == expected)

    passed: set[str] = set()
    for participant_id, checks in checks_by_participant.items():
        if checks and all(checks):
            passed.add(participant_id)
    return passed


def summarize(rows: list[dict]) -> list[tuple[str, str, int, int, float, float, float]]:
    grouped: dict[tuple[str, str], dict[str, int]] = defaultdict(lambda: {"n": 0, "baseline_better": 0})
    for r in rows:
        if r.get("trial_type") != "main":
            continue
        cp = r.get("candidate_profile")
        dc = r.get("device_class")
        if not isinstance(cp, str) or not isinstance(dc, str):
            continue
        key = (cp, dc)
        grouped[key]["n"] += 1
        if r.get("choice") == "baseline":
            grouped[key]["baseline_better"] += 1

    out: list[tuple[str, str, int, int, float, float, float]] = []
    for (cp, dc), stats in sorted(grouped.items()):
        n = stats["n"]
        k = stats["baseline_better"]
        rate = k / n if n else float("nan")
        lo, hi = wilson_interval(k, n)
        out.append((cp, dc, n, k, rate, lo, hi))
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", nargs="?", default="logs.jsonl")
    args = parser.parse_args()

    path = Path(args.input)
    rows = load_jsonl(path)
    passed = passed_attention(rows)
    filtered = [r for r in rows if r.get("participant_id") in passed]
    summary = summarize(filtered)

    print("candidate_profile,device_class,n_trials,baseline_better,baseline_better_rate,wilson_low,wilson_high")
    for cp, dc, n, k, rate, lo, hi in summary:
        print(f"{cp},{dc},{n},{k},{rate:.6f},{lo:.6f},{hi:.6f}")


if __name__ == "__main__":
    main()