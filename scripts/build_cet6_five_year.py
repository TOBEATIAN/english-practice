#!/usr/bin/env python3
r"""OCR the 2022-2026 CET-6 papers and build a frequency-based wordbook.

Run with the local PaddleOCR environment:
    E:\WorkSpace\tools\paddleocr\.venv-shared\Scripts\python.exe \
        scripts\build_cet6_five_year.py

The OCR text is kept in ignored tmp/cet6_exam_text/ so an interrupted run can
resume. Only aggregate word counts and the selected wordbook are written to
tracked data files.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROJECT = ROOT.parent
PACKAGE = PROJECT / "六级资料" / "英语六级备考资料包"
PDF_DIR = PACKAGE / "【2022.12-2025.12】六级真题"
RECENT_DIR = PACKAGE / "2026年6月六级真题+答案解析+听力（三套全）" / "02、真题WORD版"
LEGACY_DIR = PACKAGE / "六级真题（2014.6-2022.9作参考）"
DICTIONARY_FILE = ROOT / "web" / "dictionary.json"
TEXT_DIR = ROOT / "tmp" / "cet6_exam_text"
PAGE_DIR = ROOT / "tmp" / "cet6_exam_pages"
OCR_PS1 = ROOT / "scripts" / "ocr_windows_batch.ps1"
COUNTS_FILE = ROOT / "data" / "cet6_five_year_counts.json"
WORD_BOOK_FILE = ROOT / "web" / "wordbooks" / "cet6-five-year.json"


def slug(value: str) -> str:
    value = re.sub(r"[^0-9A-Za-z]+", "-", value).strip("-").lower()
    return value or "exam"


def exam_buckets() -> list[dict]:
    buckets = []
    for path in sorted(PDF_DIR.glob("*.pdf")):
        buckets.append(
            {
                "id": path.stem,
                "label": path.stem.removesuffix("六级真题"),
                "kind": "pdf",
                "path": path,
            }
        )
    for path in sorted(RECENT_DIR.glob("*.docx")):
        label = path.stem.replace("2026年6月英语六级真题", "2026.6")
        buckets.append(
            {
                "id": path.stem,
                "label": label,
                "kind": "docx",
                "path": path,
            }
        )
    legacy_sources = [
        LEGACY_DIR / "2021年12月CET6" / "02、真题word" / "2021年12月六级真题全3套.docx",
        LEGACY_DIR / "2022年06月CET6" / "2022.06英语六级真题Word" / "2022.06六级真题第1套【可复制可搜索，打印首选】.docx",
        LEGACY_DIR / "2022年06月CET6" / "2022.06英语六级真题Word" / "2022.06六级真题第2套【可复制可搜索，打印首选】.docx",
        LEGACY_DIR / "2022年06月CET6" / "2022.06英语六级真题Word" / "2022.06六级真题第3套【可复制可搜索，打印首选】.docx",
        LEGACY_DIR / "2022年09月CET6" / "2022年9月六级真题.docx",
    ]
    for path in legacy_sources:
        if path.exists():
            buckets.append(
                {
                    "id": path.stem,
                    "label": path.stem.replace("英语六级真题", "2022.06").replace("六级真题", ""),
                    "kind": "docx",
                    "path": path,
                }
            )
    if not buckets:
        raise SystemExit("[FAIL] 没有找到近五年六级真题。")
    return buckets


def read_docx(path: Path) -> str:
    return subprocess.run(
        ["pandoc", "-t", "plain", str(path)],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout


def ocr_pdf(path: Path, cache: Path) -> str:
    if cache.exists() and cache.stat().st_size > 100:
        return cache.read_text(encoding="utf-8")
    image_dir = PAGE_DIR / slug(path.stem)
    image_dir.mkdir(parents=True, exist_ok=True)
    prefix = image_dir / "page"
    for old in image_dir.glob("page-*.png"):
        old.unlink()
    print(f"  render {path.name}", flush=True)
    subprocess.run(
        ["pdftoppm.exe", "-r", "180", "-png", str(path), str(prefix)],
        check=True,
        capture_output=True,
    )
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(OCR_PS1),
            "-Directory",
            str(image_dir),
        ],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    text = result.stdout.replace("\r\n", "\n")
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(text, encoding="utf-8")
    return text


def load_lemma_map(entries: dict) -> dict[str, str]:
    mapping = {}
    for key, entry in entries.items():
        surface = str(entry.get("word") or key).strip().lower()
        exchange = str(entry.get("exchange") or "")
        for token in exchange.split("/"):
            if ":" not in token:
                continue
            marker, form = token.split(":", 1)
            if marker == "0" and form:
                mapping[surface] = form.lower()
    return mapping


def normalize_token(token: str, entries: dict, lemma_map: dict[str, str]) -> str:
    word = token.lower()
    lemma = lemma_map.get(word)
    if lemma:
        return lemma
    if word in entries:
        return word
    for suffix, replacement in (("ies", "y"), ("ing", ""), ("ed", ""), ("es", ""), ("s", "")):
        if word.endswith(suffix) and len(word) > len(suffix) + 2:
            stem = word[: -len(suffix)] + replacement
            if stem in entries:
                return stem
    return word


def word_is_candidate(entry: dict) -> bool:
    tags = set(entry.get("tags") or [])
    return "cet6" in tags and "cet4" not in tags and "gk" not in tags


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="ignore OCR cache")
    args = parser.parse_args()

    dictionary = json.loads(DICTIONARY_FILE.read_text(encoding="utf-8"))["entries"]
    lemma_map = load_lemma_map(dictionary)
    buckets = exam_buckets()
    occurrence = Counter()
    bucket_hits = defaultdict(set)
    per_bucket = []
    TEXT_DIR.mkdir(parents=True, exist_ok=True)

    for index, bucket in enumerate(buckets, start=1):
        cache = TEXT_DIR / (slug(bucket["id"]) + ".txt")
        print(f"[{index}/{len(buckets)}] {bucket['label']}", flush=True)
        if bucket["kind"] == "docx":
            text = read_docx(bucket["path"])
        else:
            if args.force and cache.exists():
                cache.unlink()
            text = ocr_pdf(bucket["path"], cache)
        tokens = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", text)
        unique = set()
        for token in tokens:
            word = normalize_token(token, dictionary, lemma_map)
            entry = dictionary.get(word)
            if not entry or not word_is_candidate(entry):
                continue
            occurrence[word] += 1
            unique.add(word)
            bucket_hits[word].add(bucket["id"])
        per_bucket.append(
            {
                "id": bucket["id"],
                "label": bucket["label"],
                "tokens": len(tokens),
                "candidateUnique": len(unique),
                "ocrPages": text.count("<!-- page ") if bucket["kind"] == "pdf" else None,
            }
        )

    rows = []
    for word, count in occurrence.items():
        coverage = len(bucket_hits[word])
        entry = dictionary[word]
        # A word recurring across papers is more useful than a one-off rare word.
        score = count + coverage * 5
        rows.append(
            {
                "word": entry.get("word") or word,
                "count": count,
                "coverage": coverage,
                "score": score,
                "tags": entry.get("tags") or [],
                "collins": entry.get("collins") or "",
                "oxford": entry.get("oxford") or "",
            }
        )
    rows.sort(key=lambda row: (-row["score"], -row["coverage"], -row["count"], row["word"].lower()))

    # Frequency must generalize across exam batches; a word repeated repeatedly
    # inside one passage is not enough to qualify as a five-year high-frequency item.
    selected = [row for row in rows if row["coverage"] >= 2]
    if len(selected) > 900:
        selected = selected[:900]
    if len(selected) < 250:
        raise SystemExit(f"[FAIL] 高频词只有 {len(selected)} 个，统计或 OCR 可能异常。")

    COUNTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    COUNTS_FILE.write_text(
        json.dumps(
            {
                "version": 1,
                "period": "2021.12-2026.06",
                "buckets": per_bucket,
                "ocrPageCount": sum(item["ocrPages"] or 0 for item in per_bucket),
                "rows": rows,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    payload = {
        "version": 1,
        "title": "六级近五年高频",
        "description": "按 2021.12-2026.06 六级真题文本统计；优先选择跨场次出现、且总频次较高的六级增量词。",
        "period": "2021.12-2026.06",
        "sourceCount": len(buckets),
        "ocrPageCount": sum(item["ocrPages"] or 0 for item in per_bucket),
        "count": len(selected),
        "terms": [row["word"] for row in selected],
        "scores": {
            row["word"]: {"count": row["count"], "coverage": row["coverage"], "score": row["score"]}
            for row in selected
        },
        "source": "cet6-exams-ocr",
    }
    WORD_BOOK_FILE.parent.mkdir(parents=True, exist_ok=True)
    WORD_BOOK_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(
        f"[OK] {len(buckets)} 个真题批次，候选 {len(rows)} 词，"
        f"入选近五年高频 {len(selected)} 词",
        flush=True,
    )


if __name__ == "__main__":
    main()
