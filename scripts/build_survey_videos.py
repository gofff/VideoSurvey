from __future__ import annotations

import argparse
import json
import random
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".m4v"}


def slugify(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", value).strip("_").lower()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"Expected JSON object in {path}")
    return data


def web_playback_options(config: dict[str, Any]) -> dict[str, Any]:
    wp = config.get("web_playback", {})
    if not isinstance(wp, dict):
        return {"enabled": True}
    if "enabled" not in wp:
        wp["enabled"] = True
    return wp


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build survey clips from explicit source video paths and centers."
    )
    parser.add_argument(
        "--grid-config",
        type=Path,
        default=Path("scripts/video_grid_config.example.json"),
        help="JSON config with sources, cut window, and encoding profiles.",
    )
    parser.add_argument(
        "--videos-dir",
        type=Path,
        default=Path("videos"),
        help="Output folder for generated baseline and candidate videos.",
    )
    parser.add_argument(
        "--survey-config",
        type=Path,
        default=Path("config.json"),
        help="Survey config file to append generated trial entries into.",
    )
    parser.add_argument(
        "--report-path",
        type=Path,
        default=Path("videos/conversion_report.json"),
        help="JSON report path for process time and storage usage per output video.",
    )
    parser.add_argument(
        "--no-update-config",
        action="store_true",
        help="Do not modify survey config; only generate videos and report.",
    )
    parser.add_argument(
        "--ffmpeg-bin",
        default="ffmpeg",
        help="Path to ffmpeg executable.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing generated videos.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print ffmpeg commands without executing them.",
    )
    return parser.parse_args()


def parse_hhmmss_to_seconds(value: str) -> float:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("center must be non-empty string in HH:MM:SS")

    parts = value.strip().split(":")
    if len(parts) != 3:
        raise ValueError(f"Invalid center time format '{value}', expected HH:MM:SS")

    h, m, s = parts
    try:
        hh = int(h)
        mm = int(m)
        ss = float(s)
    except ValueError as exc:
        raise ValueError(f"Invalid center time values in '{value}'") from exc

    if hh < 0 or mm < 0 or mm >= 60 or ss < 0 or ss >= 60:
        raise ValueError(f"Out-of-range center time '{value}'")

    return hh * 3600 + mm * 60 + ss


def run_ffmpeg(cmd: list[str], dry_run: bool) -> float:
    print(" ".join(cmd))
    if dry_run:
        return 0.0
    t0 = time.perf_counter()
    subprocess.run(cmd, check=True)
    return time.perf_counter() - t0


def file_stats(path: Path) -> tuple[int | None, float | None]:
    if not path.exists() or not path.is_file():
        return (None, None)
    size_bytes = path.stat().st_size
    size_mb = size_bytes / (1024.0 * 1024.0)
    return (size_bytes, size_mb)


def build_time_window(config: dict[str, Any], center_hhmmss: str) -> tuple[float, float]:
    tw = config.get("time_window", {})
    if not isinstance(tw, dict):
        raise ValueError("time_window must be an object")

    pre_sec = float(tw.get("pre_sec", 3))
    post_sec = float(tw.get("post_sec", 3))
    if pre_sec < 0 or post_sec < 0:
        raise ValueError("pre_sec/post_sec must be >= 0")

    duration = pre_sec + post_sec
    if duration <= 0:
        raise ValueError("pre_sec + post_sec must be > 0")

    center_sec = parse_hhmmss_to_seconds(center_hhmmss)
    start = max(0.0, center_sec - pre_sec)
    return start, duration


def resolve_profile_with_same(
    baseline_profile: dict[str, Any], candidate_profile: dict[str, Any]
) -> dict[str, Any]:
    merged = dict(baseline_profile)
    for key, value in candidate_profile.items():
        if key == "name":
            continue
        if isinstance(value, str) and value.strip().lower() == "same":
            merged[key] = baseline_profile.get(key)
        else:
            merged[key] = value

    merged["name"] = candidate_profile["name"]
    return merged


def ffmpeg_cut_baseline(
    ffmpeg_bin: str,
    src: Path,
    dst: Path,
    start_sec: float,
    duration_sec: float,
    faststart: bool,
    wp_opts: dict[str, Any],
    overwrite: bool,
    dry_run: bool,
) -> float:
    cmd = [
        ffmpeg_bin,
        "-y" if overwrite else "-n",
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{duration_sec:.3f}",
        "-i",
        str(src),
        "-fflags",
        "+genpts",
        "-avoid_negative_ts",
        "make_zero",
        "-map",
        "0:v:0",
        "-c",
        "copy",
    ]
    if faststart:
        cmd += ["-movflags", "+faststart"]
    cmd.append(str(dst))
    return run_ffmpeg(cmd, dry_run=dry_run)


def ffmpeg_encode_candidate(
    ffmpeg_bin: str,
    src: Path,
    dst: Path,
    start_sec: float,
    duration_sec: float,
    profile: dict[str, Any],
    wp_opts: dict[str, Any],
    overwrite: bool,
    dry_run: bool,
) -> float:
    def same_as_default(value: Any, default: Any) -> Any:
        if isinstance(value, str) and value.strip().lower() == "same":
            return default
        return value if value is not None else default

    scale = same_as_default(profile.get("scale"), "3840:1080")
    fps_raw = same_as_default(profile.get("fps"), 20)
    fps = int(fps_raw)
    scaler = same_as_default(profile.get("scaler"), "bicubic")
    codec = same_as_default(profile.get("codec"), "libx264")
    preset = same_as_default(profile.get("preset"), None)
    bitrate = same_as_default(profile.get("video_bitrate"), None)
    maxrate = same_as_default(profile.get("maxrate"), None)
    bufsize = same_as_default(profile.get("bufsize"), None)
    x264_params = same_as_default(profile.get("x264_params"), None)
    crf = same_as_default(profile.get("crf"), None)
    extra_args = same_as_default(profile.get("extra_args"), [])
    faststart_raw = same_as_default(profile.get("faststart"), True)
    faststart = bool(faststart_raw)

    if extra_args and not isinstance(extra_args, list):
        raise ValueError("profile.extra_args must be a list")

    cmd = [
        ffmpeg_bin,
        "-y" if overwrite else "-n",
        "-ss",
        f"{start_sec:.3f}",
        "-t",
        f"{duration_sec:.3f}",
        "-i",
        str(src),
        "-fflags",
        "+genpts",
        "-avoid_negative_ts",
        "make_zero",
        "-vf",
        f"scale={scale}:flags={scaler}",
        "-r",
        str(fps),
        "-c:v",
        codec,
    ]

    if preset:
        cmd += ["-preset", str(preset)]
    if bitrate:
        cmd += ["-b:v", str(bitrate)]
    if maxrate:
        cmd += ["-maxrate", str(maxrate)]
    if bufsize:
        cmd += ["-bufsize", str(bufsize)]
    if x264_params and codec == "libx264":
        cmd += ["-x264-params", str(x264_params)]
    if crf is not None:
        cmd += ["-crf", str(crf)]
    if extra_args:
        cmd += [str(x) for x in extra_args]

    # Survey playback is always silent for all generated outputs.
    cmd += ["-an"]

    if bool(wp_opts.get("enabled", True)):
        pix_fmt = wp_opts.get("pix_fmt", "yuv420p")
        video_tag = wp_opts.get("video_tag", "avc1")
        if pix_fmt:
            cmd += ["-pix_fmt", str(pix_fmt)]
        if video_tag:
            cmd += ["-tag:v", str(video_tag)]

    if faststart:
        cmd += ["-movflags", "+faststart"]

    cmd.append(str(dst))
    return run_ffmpeg(cmd, dry_run=dry_run)


def append_trials_to_config(
    survey_config_path: Path,
    generated_trials: list[dict[str, Any]],
    generated_videos: list[dict[str, str]],
    dry_run: bool,
) -> None:
    survey_cfg = load_json(survey_config_path)
    existing_trials = survey_cfg.get("trials", [])
    if not isinstance(existing_trials, list):
        raise ValueError(f"Expected list in {survey_config_path}: trials")

    trial_by_id: dict[str, dict[str, Any]] = {}
    for t in existing_trials:
        if isinstance(t, dict) and isinstance(t.get("id"), str):
            trial_by_id[t["id"]] = t

    for t in generated_trials:
        trial_by_id[t["id"]] = t

    survey_cfg["trials"] = sorted(
        trial_by_id.values(), key=lambda x: str(x.get("id", ""))
    )
    survey_cfg["attention_checks"] = build_attention_checks(
        trials=survey_cfg["trials"],
        generated_videos=generated_videos,
    )

    if dry_run:
        print(f"[dry-run] Would update {survey_config_path} with {len(generated_trials)} trials")
        return

    with survey_config_path.open("w", encoding="utf-8") as f:
        json.dump(survey_cfg, f, indent=2)
        f.write("\n")
    print(f"Updated {survey_config_path} with {len(generated_trials)} generated trials")


def build_attention_checks(
    trials: list[dict[str, Any]], generated_videos: list[dict[str, str]]
) -> list[dict[str, str]]:
    checks: list[dict[str, str]] = []

    bad_trial = next(
        (
            t
            for t in trials
            if isinstance(t, dict)
            and isinstance(t.get("candidate_profile"), str)
            and "bad" in t["candidate_profile"].lower()
        ),
        None,
    )
    if bad_trial:
        checks.append(
            {
                "id": "attention_obvious_low_auto",
                "type": "obvious_low",
                "clip_id": str(bad_trial.get("clip_id", "attention_bad")),
                "baseline": str(bad_trial.get("baseline", "")),
                "candidate": str(bad_trial.get("candidate", "")),
                "candidate_profile": "attention_obvious_low",
            }
        )

    if generated_videos:
        picked = random.choice(generated_videos)
        checks.append(
            {
                "id": "attention_same_same_auto",
                "type": "same_same",
                "clip_id": str(picked.get("clip_id", "attention_same")),
                "baseline": str(picked["path"]),
                "candidate": str(picked["path"]),
                "candidate_profile": "attention_same_same",
            }
        )

    if not checks:
        print("Warning: No attention checks could be auto-generated")
    elif len(checks) == 1:
        print("Warning: Generated only one attention check")

    return checks


def validate_source_item(item: Any) -> dict[str, str]:
    if not isinstance(item, dict):
        raise ValueError("Each sources[] item must be an object")

    raw_path = item.get("path")
    center = item.get("center")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("Each source must contain non-empty string 'path'")
    if not isinstance(center, str) or not center.strip():
        raise ValueError("Each source must contain non-empty string 'center' (HH:MM:SS)")

    source_id = item.get("clip_id") or item.get("id")
    if not isinstance(source_id, str) or not source_id.strip():
        source_id = slugify(Path(raw_path).stem)

    return {"path": raw_path, "center": center, "clip_id": slugify(source_id)}


def resolve_source_path(raw_path: str, grid_config_path: Path) -> Path:
    p = Path(raw_path)
    if p.is_absolute():
        return p
    return (grid_config_path.parent / p).resolve()


def main() -> None:
    args = parse_args()
    grid_config_path = args.grid_config.resolve()
    videos_dir = args.videos_dir.resolve()
    survey_config_path = args.survey_config.resolve()
    report_path = args.report_path.resolve()

    if not grid_config_path.exists():
        raise FileNotFoundError(f"Grid config not found: {grid_config_path}")

    cfg = load_json(grid_config_path)
    wp_opts = web_playback_options(cfg)

    sources_raw = cfg.get("sources", [])
    if not isinstance(sources_raw, list) or not sources_raw:
        raise ValueError("grid config must include non-empty sources list")

    baseline_profile = cfg.get(
        "baseline_profile",
        {
            "name": "5120_10M",
            "scale": "5120:1440",
            "fps": 20,
            "codec": "libx264",
            "preset": "veryfast",
            "video_bitrate": "10M",
            "maxrate": "10M",
            "bufsize": "20M",
            "x264_params": "keyint=40:min-keyint=40:scenecut=0",
            "faststart": True,
            "include_audio": False,
        },
    )
    candidate_profiles = cfg.get("candidate_profiles", [])
    if not isinstance(candidate_profiles, list) or not candidate_profiles:
        raise ValueError("grid config must include non-empty candidate_profiles list")

    baseline_name = str(baseline_profile.get("name", "5120_10M"))
    baseline_faststart = bool(baseline_profile.get("faststart", True))

    videos_dir.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    generated_trials: list[dict[str, Any]] = []
    generated_videos: list[dict[str, str]] = []
    report_entries: list[dict[str, Any]] = []

    for item in sources_raw:
        src_item = validate_source_item(item)
        src_path = resolve_source_path(src_item["path"], grid_config_path)
        if not src_path.exists() or not src_path.is_file():
            raise FileNotFoundError(f"Source video not found: {src_path}")
        if src_path.suffix.lower() not in VIDEO_EXTENSIONS:
            raise ValueError(f"Unsupported source extension: {src_path}")

        clip_id = src_item["clip_id"]
        start_sec, duration_sec = build_time_window(cfg, src_item["center"])

        baseline_out_name = f"{clip_id}_{baseline_name}.mp4"
        baseline_out_path = videos_dir / baseline_out_name

        _baseline_elapsed = ffmpeg_cut_baseline(
            ffmpeg_bin=args.ffmpeg_bin,
            src=src_path,
            dst=baseline_out_path,
            start_sec=start_sec,
            duration_sec=duration_sec,
            faststart=baseline_faststart,
            wp_opts=wp_opts,
            overwrite=args.overwrite,
            dry_run=args.dry_run,
        )

        base_size_bytes, base_size_mb = file_stats(baseline_out_path)
        report_entries.append(
            {
                "kind": "baseline",
                "clip_id": clip_id,
                "profile_name": baseline_name,
                "source_path": str(src_path),
                "output_file": f"videos/{baseline_out_name}",
                "output_path": str(baseline_out_path),
                "start_sec": start_sec,
                "duration_sec": duration_sec,
                "process_time_sec": 0,
                "size_bytes": base_size_bytes,
                "size_mb": round(base_size_mb, 6) if base_size_mb is not None else None,
            }
        )
        generated_videos.append({"clip_id": clip_id, "path": f"videos/{baseline_out_name}"})

        for candidate_raw in candidate_profiles:
            if not isinstance(candidate_raw, dict):
                raise ValueError("Each candidate profile must be an object")
            profile_name = candidate_raw.get("name")
            if not isinstance(profile_name, str) or not profile_name:
                raise ValueError("Each candidate profile must have non-empty 'name'")

            candidate_profile = resolve_profile_with_same(baseline_profile, candidate_raw)

            candidate_out_name = f"{clip_id}_{profile_name}.mp4"
            candidate_out_path = videos_dir / candidate_out_name

            elapsed = ffmpeg_encode_candidate(
                ffmpeg_bin=args.ffmpeg_bin,
                src=src_path,
                dst=candidate_out_path,
                start_sec=start_sec,
                duration_sec=duration_sec,
                profile=candidate_profile,
                wp_opts=wp_opts,
                overwrite=args.overwrite,
                dry_run=args.dry_run,
            )

            cand_size_bytes, cand_size_mb = file_stats(candidate_out_path)
            report_entries.append(
                {
                    "kind": "candidate",
                    "clip_id": clip_id,
                    "profile_name": profile_name,
                    "source_path": str(src_path),
                    "output_file": f"videos/{candidate_out_name}",
                    "output_path": str(candidate_out_path),
                    "start_sec": start_sec,
                    "duration_sec": duration_sec,
                    "process_time_sec": round(elapsed, 6),
                    "size_bytes": cand_size_bytes,
                    "size_mb": round(cand_size_mb, 6) if cand_size_mb is not None else None,
                }
            )
            generated_videos.append(
                {"clip_id": clip_id, "path": f"videos/{candidate_out_name}"}
            )

            generated_trials.append(
                {
                    "id": f"{clip_id}_{profile_name}",
                    "clip_id": clip_id,
                    "baseline": f"videos/{baseline_out_name}",
                    "candidate": f"videos/{candidate_out_name}",
                    "candidate_profile": profile_name,
                    "baseline_size_mb": round(base_size_mb, 6) if base_size_mb is not None else None,
                    "candidate_size_mb": round(cand_size_mb, 6) if cand_size_mb is not None else None,
                    "candidate_encode_sec": round(elapsed, 6),
                }
            )

    if not args.no_update_config:
        append_trials_to_config(
            survey_config_path=survey_config_path,
            generated_trials=generated_trials,
            generated_videos=generated_videos,
            dry_run=args.dry_run,
        )

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dry_run": bool(args.dry_run),
        "entries": report_entries,
    }

    if args.dry_run:
        print(f"[dry-run] Would write conversion report: {report_path}")
    else:
        with report_path.open("w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
            f.write("\n")
        print(f"Wrote conversion report: {report_path}")

    print(
        f"Done. Sources: {len(sources_raw)} | Generated trials: {len(generated_trials)} | "
        f"Output folder: {videos_dir}"
    )


if __name__ == "__main__":
    main()
