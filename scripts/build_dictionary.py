#!/usr/bin/env python3
"""Build the offline learner dictionary and CET wordbook lists from ECDICT.

The generated website never depends on a dictionary API. Only CET-4/CET-6
entries are copied into the web bundle so phone/tablet first load stays small.

Usage:
    python scripts/build_dictionary.py --input tmp/ecdict.csv

Source: https://github.com/skywind3000/ECDICT (MIT License)
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
PHRASE_TAIL = {
    "about", "above", "across", "after", "against", "along", "around", "as",
    "at", "away", "back", "by", "down", "for", "from", "in", "into", "of",
    "off", "on", "out", "over", "through", "to", "together", "under", "up",
    "upon", "with", "without",
}
EXTRA_TERMS_FILE = ROOT / "data" / "cet6_compact_terms.json"


def clean_lines(value: str) -> str:
    lines = []
    text = str(value or "").replace("\\n", "\n").replace("\r", "\n")
    for line in text.split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        if not line or line.startswith("[网络]"):
            continue
        if line not in lines:
            lines.append(line)
    return "\n".join(lines)


def merge_field(current: dict, row: dict, key: str) -> None:
    value = clean_lines(row.get(key, ""))
    if not value:
        return
    prior = current.get(key, "")
    if not prior:
        current[key] = value
        return
    for line in value.split("\n"):
        if line not in prior.split("\n"):
            prior += "\n" + line
    current[key] = prior


def is_common_phrase(word: str, translation: str) -> bool:
    """Include common 2–5 word combinations whose final word is a particle/preposition.

    This covers expressions such as "deal with", "be likely to" and "in terms of"
    without bundling ECDICT's hundreds of thousands of noisy multi-word records.
    """
    if not translation:
        return False
    words = word.lower().split()
    if not (2 <= len(words) <= 5) or words[-1] not in PHRASE_TAIL:
        return False
    return all(re.fullmatch(r"[a-z']+", item) for item in words)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--input",
        default=str(ROOT / "tmp" / "ecdict.csv"),
        help="ECDICT CSV file",
    )
    args = parser.parse_args()
    source = Path(args.input)
    if not source.exists():
        raise SystemExit(
            f"[FAIL] 找不到 {source}。先从 https://github.com/skywind3000/ECDICT "
            "下载 ecdict.csv 到 tmp/ecdict.csv。"
        )

    entries: dict[str, dict] = {}
    cet4: set[str] = set()
    cet6: set[str] = set()
    extra_terms: set[str] = set()
    if EXTRA_TERMS_FILE.exists():
        extra_data = json.loads(EXTRA_TERMS_FILE.read_text(encoding="utf-8"))
        extra_terms = {str(word).strip().lower() for word in extra_data.get("terms", []) if str(word).strip()}

    with source.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            tags = set((row.get("tag") or "").split())
            has4 = "cet4" in tags
            has6 = "cet6" in tags
            word = (row.get("word") or "").strip()
            translation = row.get("translation") or ""
            phrase_extra = is_common_phrase(word, translation)
            compact_extra = word.lower() in extra_terms
            if not (has4 or has6 or phrase_extra or compact_extra):
                continue
            key = word.lower()
            if not key:
                continue
            if has4:
                cet4.add(word)
            if has6:
                cet6.add(word)
            if phrase_extra:
                tags.add("phrase")
            if compact_extra:
                tags.add("cet6-compact")

            item = entries.setdefault(
                key,
                {
                    "word": word,
                    "ipa": "",
                    "en": "",
                    "cn": "",
                    "pos": "",
                    "exchange": "",
                    "tags": [],
                    "collins": "",
                    "oxford": "",
                },
            )
            item["ipa"] = item["ipa"] or (row.get("phonetic") or "").strip()
            item["pos"] = item["pos"] or (row.get("pos") or "").strip()
            item["exchange"] = item["exchange"] or (row.get("exchange") or "").strip()
            item["collins"] = item["collins"] or (row.get("collins") or "").strip()
            item["oxford"] = item["oxford"] or (row.get("oxford") or "").strip()
            item["tags"] = sorted(set(item["tags"]) | tags)
            merge_field(item, row, "definition")
            merge_field(item, row, "translation")
            item["en"] = item.pop("definition", "")
            item["cn"] = item.pop("translation", "")

    if len(entries) < 5000:
        raise SystemExit(f"[FAIL] 只解析到 {len(entries)} 个词条，疑似 ECDICT 文件不完整。")
    if not cet4 or not cet6:
        raise SystemExit("[FAIL] 四级或六级词书为空。")

    web = ROOT / "web"
    books = web / "wordbooks"
    books.mkdir(parents=True, exist_ok=True)
    generated = datetime.now().replace(microsecond=0).isoformat()
    payload = {
        "version": 1,
        "source": "ECDICT",
        "sourceUrl": "https://github.com/skywind3000/ECDICT",
        "license": "MIT",
        "generatedAt": generated,
        "count": len(entries),
        "entries": entries,
    }
    (web / "dictionary.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    for name, words in (("cet4", cet4), ("cet6", cet6)):
        data = {
            "version": 1,
            "title": "四级词汇" if name == "cet4" else "六级词汇",
            "count": len(words),
            "terms": sorted(words, key=lambda value: (value.lower(), value)),
        }
        (books / f"{name}.json").write_text(
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

    print(
        f"[OK] ECDICT 六级相关词条 {len(entries)}；"
        f"四级词书 {len(cet4)}；六级词书 {len(cet6)}"
    )


if __name__ == "__main__":
    main()
