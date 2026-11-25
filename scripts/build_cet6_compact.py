#!/usr/bin/env python3
"""Build a concise CET-6 wordbook from local exam sources.

The base is the locally supplied "六级真题已考大纲词汇" list. The script adds
only CET-6-specific words that recur in the three June 2026 papers and are not
already in that base. CET-4 / high-school-only words are excluded.
"""

from __future__ import annotations

import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

import pymupdf


ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT.parent
PACKAGE = PROJECT / "六级资料" / "英语六级备考资料包"
TESTED_PDF = PACKAGE / "六级真题已考大纲词汇.pdf"
RECENT_DIR = PACKAGE / "2026年6月六级真题+答案解析+听力（三套全）" / "02、真题WORD版"
DICTIONARY_FILE = ROOT / "web" / "dictionary.json"
DATA_FILE = ROOT / "data" / "cet6_compact_terms.json"
OUT_FILE = ROOT / "web" / "wordbooks" / "cet6-compact.json"


def extract_pdf_words() -> list[str]:
    doc = pymupdf.open(TESTED_PDF)
    text = "\n".join(page.get_text() for page in doc)
    lines = [line.strip() for line in text.splitlines()]
    words: list[str] = []
    seen: set[str] = set()
    for index, line in enumerate(lines[:-1]):
        if not re.fullmatch(r"\d{3}", line):
            continue
        candidate = lines[index + 1].strip()
        if not re.fullmatch(r"[A-Za-z][A-Za-z' -]*", candidate):
            continue
        if candidate == "notwithstandin":
            candidate = "notwithstanding"
        key = candidate.lower()
        if key not in seen:
            words.append(candidate)
            seen.add(key)
    return words


def extract_recent_words() -> tuple[Counter[str], dict[str, set[str]]]:
    counts: Counter[str] = Counter()
    set_presence: dict[str, set[str]] = defaultdict(set)
    for path in sorted(RECENT_DIR.glob("*.docx")):
        text = subprocess.run(
            ["pandoc", "-t", "plain", str(path)],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout
        for word in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", text.lower()):
            counts[word] += 1
            set_presence[word].add(path.name)
    return counts, set_presence


def main() -> None:
    if not TESTED_PDF.exists():
        raise SystemExit(f"[FAIL] 缺少真题词表：{TESTED_PDF}")
    if not RECENT_DIR.exists():
        raise SystemExit(f"[FAIL] 缺少 2026 三套 Word 版：{RECENT_DIR}")
    dictionary = json.loads(DICTIONARY_FILE.read_text(encoding="utf-8"))["entries"]

    base = extract_pdf_words()
    if len(base) < 700:
        raise SystemExit(f"[FAIL] 真题词表只解析到 {len(base)} 词，疑似提取失败。")
    base_set = {word.lower() for word in base}

    recent_counts, recent_sets = extract_recent_words()
    recent_extra: list[str] = []
    for word, count in recent_counts.items():
        entry = dictionary.get(word)
        if not entry:
            continue
        tags = set(entry.get("tags") or [])
        if "cet6" not in tags or "cet4" in tags or "gk" in tags:
            continue
        if word in base_set:
            continue
        # Require recurrence: repeated in the same set or present in 2+ sets.
        if count >= 2 or len(recent_sets[word]) >= 2:
            recent_extra.append(word)

    recent_extra.sort()
    terms = base + recent_extra
    if len(terms) < 800 or len(terms) > 1200:
        raise SystemExit(f"[FAIL] 精简词书规模异常：{len(terms)}")

    payload = {
        "version": 1,
        "title": "六级真题精简",
        "description": "以真题已考大纲词为主，补入 2026 年 6 月三套中重复出现的六级增量词；不含四级和高考基础词。",
        "baseTitle": "六级真题已考大纲词汇",
        "baseCount": len(base),
        "recent2026Added": len(recent_extra),
        "recentOnlyExamples": recent_extra[:20],
        "count": len(terms),
        "terms": terms,
        "source": "local-cet6-exams",
    }
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    OUT_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"[OK] 真题已考 {len(base)} + 2026 重复增量 {len(recent_extra)} "
        f"→ 六级真题精简 {len(terms)}"
    )


if __name__ == "__main__":
    main()
