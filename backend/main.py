from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

LOG_PATH = Path("logs.jsonl")
CONVERSION_REPORT_PATH = Path("videos/conversion_report.json")
WRITE_LOCK = Lock()


@app.post("/log")
async def log_trial(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid_json") from exc

    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="invalid_payload")

    line = json.dumps(payload, ensure_ascii=False)
    with WRITE_LOCK:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    return {"ok": True}


def _load_logs() -> list[dict[str, Any]]:
    if not LOG_PATH.exists():
        return []
    rows: list[dict[str, Any]] = []
    with LOG_PATH.open("r", encoding="utf-8") as f:
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


def _expected_choice(trial_type: str | None) -> str | None:
    if trial_type == "obvious_low":
        return "baseline"
    if trial_type == "same_same":
        return "nodiff"
    return None


def _attention_checks_by_participant(rows: list[dict[str, Any]]) -> dict[str, list[bool]]:
    checks_by_participant: dict[str, list[bool]] = defaultdict(list)
    for r in rows:
        participant_id = r.get("participant_id")
        if not isinstance(participant_id, str):
            continue
        expected = r.get("expected_choice")
        if not isinstance(expected, str):
            expected = _expected_choice(r.get("trial_type"))
        if expected is None:
            continue
        checks_by_participant[participant_id].append(r.get("choice") == expected)
    return checks_by_participant


def _attention_pass_participants(rows: list[dict[str, Any]]) -> set[str]:
    checks_by_participant = _attention_checks_by_participant(rows)

    passed: set[str] = set()
    for participant_id, checks in checks_by_participant.items():
        if checks and all(checks):
            passed.add(participant_id)
    return passed


def _extract_mbps(profile: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*m", profile.lower())
    if m:
        return float(m.group(1))
    return None


def _conversion_stats() -> dict[str, dict[str, float]]:
    if not CONVERSION_REPORT_PATH.exists():
        return {}
    try:
        payload = json.loads(CONVERSION_REPORT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    entries = payload.get("entries", [])
    if not isinstance(entries, list):
        return {}

    grouped: dict[str, dict[str, float]] = defaultdict(
        lambda: {"count": 0.0, "size_mb_sum": 0.0, "encode_sec_sum": 0.0}
    )
    for e in entries:
        if not isinstance(e, dict):
            continue
        profile_name = e.get("profile_name")
        if not isinstance(profile_name, str):
            continue
        grouped[profile_name]["count"] += 1
        size_mb = e.get("size_mb")
        if isinstance(size_mb, (int, float)):
            grouped[profile_name]["size_mb_sum"] += float(size_mb)
        encode_sec = e.get("process_time_sec")
        if isinstance(encode_sec, (int, float)):
            grouped[profile_name]["encode_sec_sum"] += float(encode_sec)

    out: dict[str, dict[str, float]] = {}
    for profile, stats in grouped.items():
        n = stats["count"] or 1.0
        out[profile] = {
            "avg_size_mb": stats["size_mb_sum"] / n,
            "avg_encode_sec": stats["encode_sec_sum"] / n,
        }
    return out


@app.get("/stats")
def get_stats(
    attention_filter: str = "pass_only",
    attention_fail_weight: float = 0.35,
    max_events: int = 200,
):
    rows = _load_logs()
    checks_by_participant = _attention_checks_by_participant(rows)
    passed = _attention_pass_participants(rows)
    all_participants = sorted(
        {r.get("participant_id") for r in rows if isinstance(r.get("participant_id"), str)}
    )
    participant_alias = {pid: f"user-{i+1}" for i, pid in enumerate(all_participants)}

    if attention_filter == "pass_only":
        filtered = [r for r in rows if r.get("participant_id") in passed]
    else:
        filtered = rows

    participant_weight: dict[str, float] = {}
    for pid in all_participants:
        checks = checks_by_participant.get(pid, [])
        if not checks:
            participant_weight[pid] = 1.0
        elif all(checks):
            participant_weight[pid] = 1.0
        else:
            participant_weight[pid] = max(0.0, min(1.0, attention_fail_weight))

    main_rows = [r for r in filtered if r.get("trial_type") == "main"]
    grouped: dict[tuple[str, str], dict[str, float]] = defaultdict(
        lambda: {
            "n_raw": 0.0,
            "n_weighted": 0.0,
            "baseline_w": 0.0,
            "candidate_w": 0.0,
            "nodiff_w": 0.0,
        }
    )

    for r in main_rows:
        pid = r.get("participant_id")
        if not isinstance(pid, str):
            continue
        profile = r.get("candidate_profile")
        device = r.get("device_class")
        choice = r.get("choice")
        if not isinstance(profile, str) or not isinstance(device, str):
            continue
        key = (profile, device)
        w = participant_weight.get(pid, 1.0)
        grouped[key]["n_raw"] += 1
        grouped[key]["n_weighted"] += w
        if choice == "baseline":
            grouped[key]["baseline_w"] += w
        elif choice == "candidate":
            grouped[key]["candidate_w"] += w
        elif choice == "nodiff":
            grouped[key]["nodiff_w"] += w

    conv = _conversion_stats()
    summary_rows: list[dict[str, Any]] = []
    for (profile, device), s in sorted(grouped.items()):
        n_raw = int(s["n_raw"])
        n_weighted = float(s["n_weighted"])
        if n_raw <= 0 or n_weighted <= 0:
            continue
        no_diff_rate = s["nodiff_w"] / n_weighted
        baseline_rate = s["baseline_w"] / n_weighted
        candidate_rate = s["candidate_w"] / n_weighted
        cstats = conv.get(profile, {})
        summary_rows.append(
            {
                "candidate_profile": profile,
                "device_class": device,
                "bitrate_mbps": _extract_mbps(profile),
                "n_trials_raw": n_raw,
                "n_trials_weighted": n_weighted,
                "no_diff_rate": no_diff_rate,
                "baseline_better_rate": baseline_rate,
                "candidate_better_rate": candidate_rate,
                "avg_size_mb": cstats.get("avg_size_mb"),
                "avg_encode_sec": cstats.get("avg_encode_sec"),
            }
        )

    events = []
    for r in rows[-max_events:]:
        pid = r.get("participant_id")
        if not isinstance(pid, str):
            continue
        baseline_side = r.get("baseline_side")
        choice = r.get("choice")
        trial_id = r.get("trial_id")
        device = r.get("device_class")
        picked = "unknown"
        if choice == "nodiff":
            picked = "no difference"
        elif baseline_side in {"A", "B"} and choice in {"baseline", "candidate"}:
            if (baseline_side == "A" and choice == "baseline") or (
                baseline_side == "B" and choice == "candidate"
            ):
                picked = "version1"
            else:
                picked = "version2"
        events.append(
            {
                "text": (
                    f"{participant_alias[pid]} on {device or 'unknown_device'} "
                    f"in trial {trial_id or 'unknown_trial'} chose {picked}"
                ),
                "timestamp": r.get("timestamp"),
            }
        )

    participants_filtered = sorted(
        {
            r.get("participant_id")
            for r in filtered
            if isinstance(r.get("participant_id"), str)
        }
    )

    return {
        "ok": True,
        "attention_filter": attention_filter,
        "attention_fail_weight": attention_fail_weight,
        "totals": {
            "events_all": len(rows),
            "events_filtered": len(filtered),
            "participants_all": len(all_participants),
            "participants_pass_attention": len(passed),
            "participants_filtered": len(participants_filtered),
            "main_trials_filtered": len(main_rows),
        },
        "summary": summary_rows,
        "events": events,
    }
