#!/usr/bin/env python3
"""Apply source-audited verdict overrides while preserving automatic judgments."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--reviews", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    reviews = json.loads(args.reviews.read_text(encoding="utf-8"))["reviews"]
    by_id = {review["id"]: review for review in reviews}
    rows = [
        json.loads(line)
        for line in args.input.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in rows:
            review = by_id.get(row["id"])
            if review:
                automatic = dict(row.get("judgment") or {})
                row["automatic_judgment"] = automatic
                row["judgment"] = {
                    **automatic,
                    **{key: value for key, value in review.items() if key != "id"},
                    "source_audited": True,
                }
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")
    temporary.replace(args.output)
    print(f"applied {len(by_id)} reviews -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
