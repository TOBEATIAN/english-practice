#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""影子跟读 md 源稿 -> A4 精简打印版 docx。

用法:
    python build_print_docx.py                 # 处理上级目录(英语练习台/)下全部 md
    python build_print_docx.py 某篇.md         # 只处理指定文件

打印版只保留：英文正文 -> 生词自查表 -> 好词好句·短语积累 -> 全文中文翻译(最下方)。
练习步骤、材料信息、音频行只存在于 md 源稿，不会进入 docx。
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
REFERENCE = SCRIPT_DIR / "print-reference.docx"
EN_TEXT_HEAD = "## English Text"
REQUIRED_HEADS = (
    "## English Text",
    "## 生词自查表",
    "## 好词好句·短语积累",
    "## 全文中文翻译",
)


def build_print_docx(md: Path, pandoc: str) -> None:
    lines = md.read_text(encoding="utf-8").splitlines()

    h1_idx = next((i for i, ln in enumerate(lines) if ln.startswith("# ")), None)
    if h1_idx is None:
        raise SystemExit(f"缺少 H1 标题：{md}")

    # 校验固定标题存在且顺序正确，避免静默生成残缺打印版
    found = {ln.strip(): i for i, ln in enumerate(lines) if ln.strip() in REQUIRED_HEADS}
    missing = [h for h in REQUIRED_HEADS if h not in found]
    if missing:
        raise SystemExit(f"源稿缺少标题 {missing}：{md}（未生成 docx）")
    order = [found[h] for h in REQUIRED_HEADS]
    if order != sorted(order):
        raise SystemExit(f"源稿标题顺序不符合契约：{md}（未生成 docx）")

    title = lines[h1_idx][2:].strip()
    eng_title = title.split("｜", 1)[1] if "｜" in title else title

    out_lines = [f"# {title}", ""]
    started = False
    skip_title_para = False
    for ln in lines:
        s = ln.strip()
        if not started:
            if s == EN_TEXT_HEAD:
                started = True
                out_lines.append("## 英文正文")
                skip_title_para = True
            continue
        if skip_title_para:
            if not s:
                continue
            skip_title_para = False
            if s.startswith("**") and s.endswith("**") and s.strip("*") == eng_title:
                continue
        if s == "---":
            continue
        out_lines.append(ln)

    fd, tmp = tempfile.mkstemp(suffix=".md", prefix="shadow_print_")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out_lines) + "\n")
    out_path = md.with_suffix(".docx")
    try:
        subprocess.run(
            [
                pandoc,
                tmp,
                "-f",
                "markdown",
                "--reference-doc",
                str(REFERENCE),
                "-o",
                str(out_path),
            ],
            check=True,
        )
    finally:
        os.unlink(tmp)
    print(f"已生成：{out_path}")


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="影子跟读 md -> docx 打印版")
    parser.add_argument("files", nargs="*", help="md 文件；缺省处理上级目录全部 md")
    args = parser.parse_args()

    pandoc = shutil.which("pandoc")
    if not pandoc:
        sys.exit("错误：未找到 pandoc")
    if not REFERENCE.exists():
        sys.exit(f"错误：缺少版式文件 {REFERENCE}")

    if args.files:
        mds = [Path(f).resolve() for f in args.files]
    else:
        mds = []
        for sub in sorted(ROOT_DIR.iterdir()):
            if sub.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", sub.name):
                mds.extend(sorted(sub.glob("*.md")))
        mds.extend(sorted(p for p in ROOT_DIR.glob("*.md") if p.name != "README.md"))
        mds = sorted(mds, key=str)
    if not mds:
        sys.exit("没有找到可转换的 md")

    failed = False
    for md in mds:
        try:
            build_print_docx(md, pandoc)
        except SystemExit as exc:
            failed = True
            print(exc)
        except Exception as exc:  # noqa: BLE001
            failed = True
            print(f"转换失败：{md} -> {exc}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
