#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生词音标库生成器：把网站里出现的词形转成 IPA，写进 docs\\生词_音标库.json。

数据来源：本机离线发音词典 `eng_to_ipa`（CMU 发音词典 + IPA 转换，不联网）。
装法（用模拟卷那个 venv）：
    <模拟卷>\\scripts\\.venv\\Scripts\\python.exe -m pip install eng_to_ipa

用法：
    python build_ipa.py            # 补齐缺的音标（已有的不覆盖）
    python build_ipa.py --report   # 只统计覆盖率并列出仍然缺的词，不写文件

约定：
1. **已有的音标一律不覆盖** —— 专名（Dunhuang / Peking Opera / Shaanxi…）与英式拼写的
   音标是手工填进去的，重跑不会丢；
2. 词形取自 `web\\vocab.json` 的卡片词条与 `web\\materials.json` 的词表，按小写去重；
3. 短语按词拆开、逐词给音标再用空格连起来；
4. 输出风格统一成"带长音符号"的写法：i→iː、u→uː、ɑ→ɑː、ɝ→ɝː，ɔ 只在不是 ɔɪ 时加长。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path(__file__).resolve().parent.parent          # 英语练习台/
PROJECT = BASE.parent                                   # Project_02_六级/
DOCS = PROJECT / "docs"
OUT_FILE = DOCS / "生词_音标库.json"
VOCAB_JSON = BASE / "web" / "vocab.json"
MATERIALS_JSON = BASE / "web" / "materials.json"

WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")


def load_json(path: Path, default):
    if not path.exists():
        return default
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def term_words(term: str) -> list[str]:
    """把一个词条拆成小写词形（短语拆词、连字符词再拆一层）"""
    out: list[str] = []
    for raw in WORD_RE.findall(str(term)):
        for part in raw.replace("-", " ").split():
            w = part.lower().strip("'")
            if w:
                out.append(w)
    return out


def collect_words() -> dict[str, int]:
    """统计需要音标的词形与出现次数"""
    need: dict[str, int] = {}

    deck = load_json(VOCAB_JSON, {}).get("cards", [])
    for card in deck:
        for w in term_words(card.get("term", "")):
            need[w] = need.get(w, 0) + 1

    materials = load_json(MATERIALS_JSON, {}).get("materials", [])
    for m in materials:
        for row in m.get("vocabRows", []) or []:
            for w in term_words(row[0]):
                need[w] = need.get(w, 0) + 1

    return need


IPA_VOWELS = set("iɪeɛæɑaɔoʊuʌəɝɚ")


def fix_length(ipa: str) -> str:
    """统一成长音符号写法（i→iː / u→uː / ɑ→ɑː / ɔ→ɔː / ɝ→ɝː）。

    只给**音节核**的那个元音加长：每个音节（词首、ˈ 后、ˌ 后）遇到的第一个元音才是核，
    后面同段里的元音属于后续音节，不加——否则 `deliberately` 会被写成 `dɪˈlɪbərətliː`。
    `ɔ` 后紧跟 ɪ（ɔɪ 双元音）时也不加长。
    """
    out: list[str] = []
    at_nucleus = True
    for i, ch in enumerate(ipa):
        nxt = ipa[i + 1] if i + 1 < len(ipa) else ""
        if ch in "ˈˌ":
            out.append(ch)
            at_nucleus = True
            continue
        if ch in IPA_VOWELS:
            long_vowel = at_nucleus and ch in "iuɑɔɝ" and nxt != "ː" and not (ch == "ɔ" and nxt == "ɪ")
            out.append(ch + "ː" if long_vowel else ch)
            at_nucleus = False
            continue
        out.append(ch)
    return "".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description="生成生词音标库")
    parser.add_argument("--report", action="store_true", help="只统计，不写文件")
    args = parser.parse_args()

    try:
        import eng_to_ipa as ipa  # noqa: PLC0415  （延迟导入，好给出友好的安装提示）
    except ImportError:
        print("[FAIL] 没装 eng_to_ipa。先跑：")
        print(r"  E:\WorkSpace\Project_04_专门学习\Project_02_六级\模拟卷\scripts\.venv\Scripts\python.exe -m pip install eng_to_ipa")
        return 1

    need = collect_words()
    if not need:
        print("[FAIL] 没收集到任何词形（先跑 build_site.py / build_vocab_deck.js 生成 web\\*.json）")
        return 1

    data = load_json(OUT_FILE, {})
    if not isinstance(data, dict):
        print("[FAIL] 音标库顶层应为对象")
        return 1
    words = data.get("words")
    if not isinstance(words, dict):
        words = {}

    before = len(words)
    missing: list[str] = []
    for w in sorted(need):
        if words.get(w):
            continue
        res = ipa.convert(w)
        if res.endswith("*") or not res:
            missing.append(w)
            continue
        words[w] = fix_length(res)

    covered = sum(1 for w in need if words.get(w))
    total = len(need)
    print(f"词形 {total} 个：有音标 {covered} 个（{covered * 100.0 / total:.1f}%），仍缺 {len(missing)} 个")
    print(f"音标库新增 {len(words) - before} 条，现有 {len(words)} 条")
    if missing:
        print("仍然缺音标（专名请手工补，重跑不会覆盖）：")
        for w in missing:
            print("   -", w)

    if args.report:
        return 0

    data = {
        "_说明": "生词音标库。key 用小写词形，value 是 IPA（不带斜杠）。"
        "由 build_ipa.py 用离线词典 eng_to_ipa 自动补全，"
        "**已有的值不会被覆盖**——专名（Dunhuang / Mogao / Peking Opera 等）与英式拼写是手工补的，请直接编辑本文件。",
        "words": dict(sorted(words.items())),
    }
    DOCS.mkdir(parents=True, exist_ok=True)
    with OUT_FILE.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"[OK] {OUT_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
