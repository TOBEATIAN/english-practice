#!/usr/bin/env python3
"""Merge the five-year high-frequency and tested-word CET-6 books."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
BOOK_DIR = ROOT / "web" / "wordbooks"
FIVE_YEAR_FILE = BOOK_DIR / "cet6-five-year.json"
COMPACT_FILE = BOOK_DIR / "cet6-compact.json"
OUT_FILE = BOOK_DIR / "cet6-combined.json"


def add_unique(target: list[str], seen: set[str], words: list[str]) -> int:
    added = 0
    for word in words:
        key = str(word).strip().lower()
        if not key or key in seen:
            continue
        target.append(str(word).strip())
        seen.add(key)
        added += 1
    return added


def main() -> None:
    five_year = json.loads(FIVE_YEAR_FILE.read_text(encoding="utf-8"))
    compact = json.loads(COMPACT_FILE.read_text(encoding="utf-8"))
    terms: list[str] = []
    seen: set[str] = set()
    high_count = add_unique(terms, seen, five_year.get("terms", []))
    extension_count = add_unique(terms, seen, compact.get("terms", []))
    if high_count < 300:
        raise SystemExit(f"[FAIL] 近五年高频词只有 {high_count} 个，疑似数据缺失。")
    if len(terms) < 800:
        raise SystemExit(f"[FAIL] 合订词书只有 {len(terms)} 个，疑似数据缺失。")

    payload = {
        "version": 1,
        "title": "六级高频合订",
        "description": "先学近五年真题高频，再补真题已考精简词；两本合并去重。",
        "count": len(terms),
        "fiveYearCount": high_count,
        "extensionCount": extension_count,
        "fiveYearPeriod": five_year.get("period"),
        "terms": terms,
        "tiers": [
            {
                "name": "近五年高频",
                "start": 0,
                "end": high_count,
            },
            {
                "name": "真题精简扩展",
                "start": high_count,
                "end": len(terms),
            },
        ],
        "source": "cet6-five-year+cet6-compact",
    }
    OUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"[OK] 近五年高频 {high_count} + 扩展 {extension_count} "
        f"→ 六级高频合订 {len(terms)}"
    )


if __name__ == "__main__":
    main()
