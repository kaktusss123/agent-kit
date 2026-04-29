#!/usr/bin/env python3
"""Initialize an LLM wiki project around an existing source root.

Usage:
    python3 init_project.py --project-root PATH_TO_WIKI_PROJECT --source-root PATH_TO_SOURCE_NOTES --project-name PROJECT_NAME

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
import json
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TEMPLATE_ROOT = Path(__file__).resolve().parents[1] / "assets" / "templates"


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


def now_iso() -> str:
    """Return current UTC time in ISO-8601 format."""
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, payload: dict[str, Any], force: bool) -> bool:
    """Write JSON unless the target exists and force is disabled."""
    if path.exists() and not force:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temp_path.replace(path)
    return True


def copy_template(template_name: str, target: Path, force: bool) -> bool:
    """Copy a template unless the target exists and force is disabled."""
    if target.exists() and not force:
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TEMPLATE_ROOT / template_name, target)
    return True


def init_project(args: argparse.Namespace) -> Result:
    """Create the project scaffold."""
    project_root = Path(args.project_root).expanduser().resolve()
    source_root = Path(args.source_root).expanduser().resolve()
    if not source_root.exists():
        return Result(False, f"Source root not found: {source_root}", errors=[str(source_root)])
    if not source_root.is_dir():
        return Result(False, f"Source root is not a directory: {source_root}", errors=[str(source_root)])

    wiki_root = project_root / "wiki"
    state_root = project_root / ".state"
    project_name = args.project_name or project_root.name

    created: list[str] = []
    skipped: list[str] = []

    for directory in (project_root, wiki_root, state_root):
        directory.mkdir(parents=True, exist_ok=True)

    template_targets = {
        "project-AGENTS.md": project_root / "AGENTS.md",
        "index.md": wiki_root / "index.md",
        "log.md": wiki_root / "log.md",
        "open-questions.md": wiki_root / "open-questions.md",
    }
    for template_name, target in template_targets.items():
        if copy_template(template_name, target, args.force):
            created.append(str(target))
        else:
            skipped.append(str(target))

    project_config = {
        "schema_version": 1,
        "project_name": project_name,
        "source_root": str(source_root),
        "wiki_root": str(wiki_root),
        "state_root": str(state_root),
        "include_globs": args.include_glob,
        "exclude_globs": args.exclude_glob,
    }
    if write_json(state_root / "project.json", project_config, args.force):
        created.append(str(state_root / "project.json"))
    else:
        skipped.append(str(state_root / "project.json"))

    manifest = {"schema_version": 1, "source_root": str(source_root), "files": {}}
    if write_json(state_root / "source_manifest.json", manifest, args.force):
        created.append(str(state_root / "source_manifest.json"))
    else:
        skipped.append(str(state_root / "source_manifest.json"))

    return Result(
        success=True,
        message="LLM wiki project initialized",
        data={
            "project_root": str(project_root),
            "source_root": str(source_root),
            "wiki_root": str(wiki_root),
            "state_root": str(state_root),
            "created": created,
            "skipped": skipped,
        },
    )


def verify_result(result: Result) -> tuple[bool, str]:
    """Verify initialization output."""
    if not result.success:
        return False, result.message
    required = ["project_root", "source_root", "wiki_root", "state_root"]
    if any(key not in result.data for key in required):
        return False, "Missing required output paths"
    return True, "Verification passed"


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse CLI arguments."""
    parser = argparse.ArgumentParser(description="Initialize an LLM wiki project.")
    parser.add_argument("--project-root", required=True, help="Wiki project root path.")
    parser.add_argument("--source-root", required=True, help="Read-only source root path.")
    parser.add_argument("--project-name", help="Stable project name.")
    parser.add_argument(
        "--include-glob",
        action="append",
        default=["**/*.md"],
        help="Source include glob. Can be passed multiple times.",
    )
    parser.add_argument(
        "--exclude-glob",
        action="append",
        default=["**/.obsidian/**", "**/.git/**", "**/.trash/**", "**/node_modules/**"],
        help="Source exclude glob. Can be passed multiple times.",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite existing scaffold files.")
    return parser.parse_args(argv)


def emit(result: Result, exit_code: int, extra_error: str | None = None) -> int:
    """Print result JSON."""
    payload = result.to_dict()
    if extra_error:
        payload["errors"] = [*payload.get("errors", []), extra_error]
    output = sys.stderr if exit_code else sys.stdout
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True), file=output)
    return exit_code


def main(argv: list[str]) -> int:
    """Run project initialization."""
    try:
        args = parse_args(argv)
        result = init_project(args)
        verified, message = verify_result(result)
        if not verified:
            return emit(result, 11, message)
        return emit(result, 0)
    except OSError as error:
        return emit(Result(False, str(error), errors=[str(error)]), 1)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
