#!/usr/bin/env python3
"""Re-score route-balanced raw results with effective tool argument semantics."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


STRUCTURED_DEFAULTS = {
    "limit": 8,
    "owner": None,
    "completion_status": None,
    "due_within_days": None,
    "overdue": None,
}
FILTER_ARGS = ("owner", "completion_status", "due_within_days", "overdue")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def effective_arg(args: dict[str, Any], key: str) -> Any:
    if key in args:
        return args[key]
    return STRUCTURED_DEFAULTS.get(key)


def call_matches(expected: dict, actual: dict, *, strict: bool) -> bool:
    if actual.get("name") != expected.get("name"):
        return False
    args = actual.get("args") or {}
    if not isinstance(args, dict):
        return False
    required = expected.get("args_required") or {}
    if strict:
        if any(key not in args or args[key] != value for key, value in required.items()):
            return False
    elif any(effective_arg(args, key) != value for key, value in required.items()):
        return False

    if expected.get("name") == "query_structured_memory":
        if not isinstance(args.get("text_query"), str):
            return False
        for key in FILTER_ARGS:
            if key not in required and effective_arg(args, key) is not None:
                return False
    elif expected.get("name") == "search_project_evidence":
        if not isinstance(args.get("query"), str) or not args["query"].strip():
            return False
    return True


def distinct_call_match(expected_calls: list[dict], actual_calls: list[dict], *, strict: bool) -> bool:
    used: set[int] = set()
    for expected in expected_calls:
        match = next((
            index for index, actual in enumerate(actual_calls)
            if index not in used and call_matches(expected, actual, strict=strict)
        ), None)
        if match is None:
            return False
        used.add(match)
    return True


def rescore(row: dict) -> dict:
    expected = row["expected"]
    debug = row.get("debug") or {}
    expected_calls = expected.get("tool_calls") or []
    actual_calls = debug.get("tool_calls") or []
    expected_tools = set(expected.get("required_tools") or [])
    allowed_tools = set(expected.get("allowed_tools") or [])
    actual_tools = set(debug.get("tools_used") or [])
    response_pass = (
        row.get("http_status") == 200
        and not row.get("error")
        and debug.get("router_stage") == "tool_agent"
    )
    selection_pass = (
        expected_tools.issubset(actual_tools)
        and actual_tools.issubset(allowed_tools)
        and actual_tools == {call.get("name") for call in actual_calls}
    )
    serialized_args_pass = distinct_call_match(expected_calls, actual_calls, strict=True)
    effective_args_pass = distinct_call_match(expected_calls, actual_calls, strict=False)
    rounds = debug.get("tool_rounds")
    rounds_pass = (
        isinstance(rounds, int)
        and 0 < rounds <= int(expected.get("max_tool_rounds") or 0)
    )
    lexical_pass = bool((row.get("answer_contract_score") or {}).get("strict_text_pass"))

    previous_tool_score = row.get("tool_score") or {}
    row["tool_score"] = {
        **previous_tool_score,
        "runner_original_exact_args_pass": previous_tool_score.get("exact_args_pass"),
        "serialized_args_pass": serialized_args_pass,
        "effective_args_pass": effective_args_pass,
        # The report's legacy reader consumes this field. Effective values are
        # the product behavior because omitted limit uses the documented default 8.
        "exact_args_pass": effective_args_pass,
        "response_pass": response_pass,
        "tool_selection_pass": selection_pass,
        "rounds_pass": rounds_pass,
        "extra_tool_calls": max(0, len(actual_calls) - len(expected_calls)),
        "scoring_version": "effective-args-v1",
    }
    row["scores"] = {
        "response": {"pass": response_pass},
        "tool_selection": {"pass": selection_pass},
        "tool_arguments": {
            "pass": effective_args_pass,
            "serialized_pass": serialized_args_pass,
        },
        "tool_rounds": {"pass": rounds_pass},
        "answer_contract": {"pass": lexical_pass, "kind": "lexical_proxy"},
        "overall": {
            "pass": all((response_pass, selection_pass, effective_args_pass, rounds_pass, lexical_pass))
        },
    }
    return row


def main() -> int:
    args = parse_args()
    rows = [
        json.loads(line)
        for line in args.input.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(args.output.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(rescore(row), ensure_ascii=False, default=str) + "\n")
    temporary.replace(args.output)
    print(f"scored {len(rows)} rows -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
