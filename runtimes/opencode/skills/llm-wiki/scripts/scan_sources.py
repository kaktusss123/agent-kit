#!/usr/bin/env python3
"""Scan source notes and compare hashes with a JSON manifest.

Usage:
    python3 scan_sources.py --project-root PATH_TO_WIKI_PROJECT
    python3 scan_sources.py --project-root PATH_TO_WIKI_PROJECT --output PATH_TO_SCAN_OUTPUT
    python3 scan_sources.py --project-root PATH_TO_WIKI_PROJECT --update-manifest --only-from-scan PATH_TO_SCAN_OUTPUT

Exit codes:
    0  - Success
    1  - General failure
    2  - Invalid arguments
    3  - File not found
    10 - Validation failure
    11 - Verification failure
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MANIFEST_NAME = "source_manifest.json"
PROJECT_CONFIG = "project.json"


@dataclass(frozen=True)
class Result:
    """Represents script execution output."""

    success: bool
    message: str
    data: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Return a JSON-serializable dictionary."""
        return {
            "success": self.success,
            "message": self.message,
            "data": self.data,
            "errors": self.errors,
            "warnings": self.warnings,
            "timestamp": now_iso(),
        }


@dataclass(frozen=True)
class ProjectConfig:
    """Stores resolved wiki project paths and scan rules."""

    project_root: Path
    source_root: Path
    wiki_root: Path
    state_root: Path
    include_globs: list[str]
    exclude_globs: list[str]


def now_iso() -> str:
    """Return current UTC time in ISO-8601 format."""
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    """Read a JSON object from disk."""
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    """Write JSON atomically."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(path)


def load_config(project_root: Path) -> ProjectConfig:
    """Load and validate project configuration."""
    resolved_root = project_root.expanduser().resolve()
    config_path = resolved_root / ".state" / PROJECT_CONFIG
    if not config_path.exists():
        raise FileNotFoundError(f"Project config not found: {config_path}")

    raw = read_json(config_path)
    source_root = Path(raw["source_root"]).expanduser().resolve()
    wiki_root = Path(raw.get("wiki_root", resolved_root / "wiki")).expanduser().resolve()
    state_root = Path(raw.get("state_root", resolved_root / ".state")).expanduser().resolve()
    include_globs = list(raw.get("include_globs", ["**/*.md"]))
    exclude_globs = list(raw.get("exclude_globs", []))

    if not source_root.exists():
        raise FileNotFoundError(f"Source root not found: {source_root}")
    if not source_root.is_dir():
        raise NotADirectoryError(f"Source root is not a directory: {source_root}")

    return ProjectConfig(
        project_root=resolved_root,
        source_root=source_root,
        wiki_root=wiki_root,
        state_root=state_root,
        include_globs=include_globs,
        exclude_globs=exclude_globs,
    )


def manifest_path(config: ProjectConfig) -> Path:
    """Return the source manifest path."""
    return config.state_root / MANIFEST_NAME


def load_manifest(config: ProjectConfig) -> dict[str, Any]:
    """Load existing manifest or create an empty one in memory."""
    path = manifest_path(config)
    if not path.exists():
        return {
            "schema_version": 1,
            "source_root": str(config.source_root),
            "files": {},
        }

    manifest = read_json(path)
    manifest.setdefault("schema_version", 1)
    manifest.setdefault("source_root", str(config.source_root))
    manifest.setdefault("files", {})
    return manifest


def is_excluded(relative_path: str, patterns: list[str]) -> bool:
    """Return whether a relative path matches any exclusion pattern."""
    return any(fnmatch.fnmatch(relative_path, pattern) for pattern in patterns)


def iter_source_files(config: ProjectConfig) -> list[Path]:
    """Return included source files sorted by relative path."""
    files: dict[str, Path] = {}
    for pattern in config.include_globs:
        for path in config.source_root.glob(pattern):
            if not path.is_file():
                continue
            relative_path = path.relative_to(config.source_root).as_posix()
            if is_excluded(relative_path, config.exclude_globs):
                continue
            files[relative_path] = path
    return [files[key] for key in sorted(files)]


def sha256_file(path: Path) -> str:
    """Compute SHA-256 for a file."""
    digest = hashlib.sha256()
    with path.open("rb") as file_obj:
        for chunk in iter(lambda: file_obj.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def current_hashes(config: ProjectConfig) -> dict[str, str]:
    """Return relative source paths mapped to SHA-256 hashes."""
    return {
        path.relative_to(config.source_root).as_posix(): sha256_file(path)
        for path in iter_source_files(config)
    }


def diff_sources(config: ProjectConfig, manifest: dict[str, Any]) -> dict[str, Any]:
    """Compare current source hashes with manifest state."""
    current = current_hashes(config)
    recorded = manifest.get("files", {})

    new_files = []
    changed_files = []
    deleted_files = []
    unchanged_count = 0

    for relative_path, file_hash in current.items():
        entry = recorded.get(relative_path)
        if entry is None:
            new_files.append({"path": relative_path, "sha256": file_hash})
            continue
        old_hash = entry.get("sha256")
        if old_hash != file_hash:
            changed_files.append(
                {
                    "path": relative_path,
                    "old_sha256": old_hash,
                    "new_sha256": file_hash,
                }
            )
            continue
        unchanged_count += 1

    for relative_path, entry in recorded.items():
        if relative_path not in current:
            deleted_files.append(
                {
                    "path": relative_path,
                    "old_sha256": entry.get("sha256"),
                }
            )

    return {
        "source_root": str(config.source_root),
        "manifest_path": str(manifest_path(config)),
        "new": new_files,
        "changed": changed_files,
        "deleted": deleted_files,
        "unchanged_count": unchanged_count,
        "current_hashes": current,
    }


def scan(config: ProjectConfig) -> Result:
    """Scan sources and return a diff result."""
    manifest = load_manifest(config)
    diff = diff_sources(config, manifest)
    changed_total = len(diff["new"]) + len(diff["changed"]) + len(diff["deleted"])
    return Result(
        success=True,
        message=f"Scan complete: {changed_total} changed source state entries",
        data=diff,
    )


def paths_from_scan(scan_path: Path) -> set[str]:
    """Return paths that should be committed from a scan output."""
    payload = read_json(scan_path.expanduser().resolve())
    data = payload.get("data", payload)
    paths = {item["path"] for item in data.get("new", [])}
    paths.update(item["path"] for item in data.get("changed", []))
    paths.update(item["path"] for item in data.get("deleted", []))
    return paths


def update_manifest(config: ProjectConfig, only_paths: set[str] | None) -> Result:
    """Update manifest hashes after a successful ingest."""
    manifest = load_manifest(config)
    current = current_hashes(config)
    files = dict(manifest.get("files", {}))
    ingest_time = now_iso()

    target_paths = only_paths if only_paths is not None else set(current.keys()) | set(files.keys())
    for relative_path in sorted(target_paths):
        if relative_path in current:
            previous = files.get(relative_path, {})
            files[relative_path] = {
                **previous,
                "sha256": current[relative_path],
                "last_ingested_at": ingest_time,
                "status": "ingested",
            }
        elif relative_path in files:
            files[relative_path] = {
                **files[relative_path],
                "deleted_at": ingest_time,
                "status": "deleted",
            }

    updated = {
        **manifest,
        "schema_version": 1,
        "source_root": str(config.source_root),
        "updated_at": ingest_time,
        "files": files,
    }
    write_json(manifest_path(config), updated)
    return Result(
        success=True,
        message=f"Manifest updated for {len(target_paths)} source paths",
        data={"manifest_path": str(manifest_path(config)), "updated_paths": sorted(target_paths)},
    )


def verify_result(result: Result) -> tuple[bool, str]:
    """Verify result shape before printing."""
    if not result.success:
        return False, result.message
    if not isinstance(result.data, dict):
        return False, "Result data must be an object"
    return True, "Verification passed"


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse CLI arguments."""
    parser = argparse.ArgumentParser(description="Scan LLM wiki source files.")
    parser.add_argument("--project-root", required=True, help="Wiki project root path.")
    parser.add_argument("--output", help="Optional JSON output path.")
    parser.add_argument(
        "--update-manifest",
        action="store_true",
        help="Update manifest after successful ingest.",
    )
    parser.add_argument(
        "--only-from-scan",
        help="Update only paths listed as new/changed/deleted in this scan JSON.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    """Run the source scanner."""
    try:
        args = parse_args(argv)
        config = load_config(Path(args.project_root))
        if args.only_from_scan and not args.update_manifest:
            return fail("--only-from-scan requires --update-manifest", 2)

        if args.update_manifest:
            only_paths = paths_from_scan(Path(args.only_from_scan)) if args.only_from_scan else None
            result = update_manifest(config, only_paths)
        else:
            result = scan(config)

        verified, message = verify_result(result)
        if not verified:
            return emit(result, args.output, 11, extra_error=message)
        return emit(result, args.output, 0)
    except FileNotFoundError as error:
        return fail(str(error), 3)
    except (KeyError, json.JSONDecodeError, NotADirectoryError) as error:
        return fail(str(error), 10)
    except OSError as error:
        return fail(str(error), 1)


def emit(result: Result, output: str | None, exit_code: int, extra_error: str | None = None) -> int:
    """Print or write result JSON."""
    payload = result.to_dict()
    if extra_error:
        payload["errors"] = [*payload.get("errors", []), extra_error]
    if output:
        write_json(Path(output).expanduser().resolve(), payload)
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return exit_code


def fail(message: str, exit_code: int) -> int:
    """Print a failed result and return an exit code."""
    result = Result(success=False, message=message, errors=[message])
    print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2, sort_keys=True), file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
