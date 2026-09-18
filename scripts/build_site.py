#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""影子跟读 md 源稿 -> web/materials.json + web/audio/ 音频副本（含分段音频）。

用法:
    python build_site.py            # 扫描上级目录(影子跟读/)全部 md 并重建网站数据

材料按生成日期归档在 `影子跟读/YYYY-MM-DD/` 子文件夹中（文件名保留日期前缀），
本脚本自动扫描全部日期夹，也兼容根目录遗留 md。
材料源稿与打印版共用同一固定标题契约；缺标题时报错并不覆盖旧 JSON。
分段音频缺失时自动用 edge-tts 合成；网络失败则该段音频置空，网页自动降级为仅整篇播放。
"""

import json
import os
import re
import sys
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
WEB_DIR = ROOT_DIR / "web"
AUDIO_DIR = WEB_DIR / "audio"
OUT_JSON = WEB_DIR / "materials.json"
REQUIRED_HEADS = (
    "## English Text",
    "## 生词自查表",
    "## 好词好句·短语积累",
    "## 全文中文翻译",
)
VOICE = "en-US-AriaNeural"
PROXY = os.environ.get("EDGE_TTS_PROXY", "http://127.0.0.1:7897")


def log(*args):
    print(*args)


def split_sentences(text: str):
    """按 .!? 切句；过短片段（<3 词）并入上一句，避免碎片句。"""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    out = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if out and len(p.split()) < 3:
            out[-1] = out[-1] + " " + p
        else:
            out.append(p)
    return out


def parse_md(md: Path) -> dict:
    lines = md.read_text(encoding="utf-8").splitlines()

    h1_idx = next((i for i, ln in enumerate(lines) if ln.startswith("# ")), None)
    if h1_idx is None:
        raise ValueError(f"{md.name}：缺少 H1 标题")
    title = lines[h1_idx][2:].strip()
    if "｜" in title:
        num, title_en = title.split("｜", 1)
        num = num.replace("影子跟读", "").strip()
    else:
        num, title_en = "", title

    heads = {ln.strip(): i for i, ln in enumerate(lines) if ln.strip() in REQUIRED_HEADS}
    missing = [h for h in REQUIRED_HEADS if h not in heads]
    if missing:
        raise ValueError(f"{md.name}：缺少标题 {missing}，未更新网站数据")
    order = [heads[h] for h in REQUIRED_HEADS]
    if order != sorted(order):
        raise ValueError(f"{md.name}：标题顺序不符合契约，未更新网站数据")

    # 材料信息（H1 之后到第一个固定标题前的引用块）
    first_head_line = min(heads.values())
    meta_lines = []
    for ln in lines[h1_idx + 1:first_head_line]:
        if ln.startswith(">"):
            meta_lines.append(ln.lstrip("> ").strip())
    meta_text = "\n".join(meta_lines)

    def find_meta(pattern):
        m = re.search(pattern, meta_text)
        return m.group(1).strip() if m else ""

    word_count_label = find_meta(r"约\s*(\d+)\s*词")
    word_count_label = f"{word_count_label} 词" if word_count_label else "—"
    difficulty = find_meta(r"难度[:：]\s*([^\s｜]+)")
    duration_label = find_meta(r"时长约\s*([^）)]+)")
    if not duration_label:
        duration_label = find_meta(r"朗读约\s*([^｜]+)")

    def section_body(start_head, end_head):
        s = heads[start_head] + 1
        e = heads[end_head] if end_head in heads else len(lines)
        return lines[s:e]

    # 英文正文段落
    eng_lines = []
    skip_first = True
    for ln in section_body("## English Text", "## 生词自查表"):
        s = ln.strip()
        if not s:
            continue
        if s == "---":
            continue
        if skip_first:
            skip_first = False
            if s.startswith("**") and s.endswith("**") and s.strip("*").strip() == title_en:
                continue
        eng_lines.append(ln)

    def md_bold_to_html(text):
        escaped = re.sub(r"\*\*(.+?)\*\*", lambda m: "<strong>" + m.group(1) + "</strong>", text)
        return escaped

    paragraphs = [md_bold_to_html(x) for x in eng_lines]
    sentences = []
    for pi, raw in enumerate(eng_lines, 1):
        for s in split_sentences(raw):
            sentences.append({
                "para": pi,
                "html": md_bold_to_html(s),
                "text": re.sub(r"\*\*(.+?)\*\*", r"\1", s),
            })
    if len(sentences) < 8:
        raise ValueError(f"{md.name}：精听句子数只有 {len(sentences)}，至少需要 8 句")

    # 生词自查表
    vocab_lines = section_body("## 生词自查表", "## 好词好句·短语积累")
    vocab_note = "\n".join(x.lstrip("> ").strip() for x in vocab_lines if x.strip().startswith(">"))
    vocab_rows = parse_table(vocab_lines)
    for row in vocab_rows:
        if len(row) != 4:
            raise ValueError(f"{md.name}：生词表应为 4 列（单词/词性/中文/英文释义），实际 {len(row)} 列")
        word, en = row[0], row[3]
        if not en.strip():
            raise ValueError(f"{md.name}：{word} 缺少英文释义")
        if re.search(r"[\u4e00-\u9fff]", en):
            raise ValueError(f"{md.name}：{word} 的英文释义含中文字符：{en}")
        n = len(en.split())
        if n < 3 or n > 14:
            raise ValueError(f"{md.name}：{word} 的英文释义需 3-14 词，实际 {n} 词：{en}")

    # 短语表
    phrase_rows = parse_table(section_body("## 好词好句·短语积累", "## 全文中文翻译"))

    # 中文翻译（跳过加粗的中文标题段）
    trans_paras = []
    title_cn = ""
    for ln in section_body("## 全文中文翻译", None):
        s = ln.strip()
        if not s:
            continue
        if not title_cn and s.startswith("**") and s.endswith("**"):
            title_cn = s.strip("*").strip()
            continue
        trans_paras.append(s)

    stem = md.stem
    date_part = stem.split("_")[0] if "_" in stem else ""
    mat_id = f"{date_part}_{num}" if date_part and num else (date_part or stem)
    return {
        "id": mat_id,
        "num": num,
        "date": date_part,
        "titleEn": title_en,
        "titleCn": title_cn,
        "stem": stem,
        "wordCountLabel": word_count_label,
        "durationLabel": duration_label,
        "difficulty": difficulty,
        "rawParagraphs": eng_lines,
        "paragraphs": paragraphs,
        "sentences": sentences,
        "vocabNote": vocab_note,
        "vocabRows": vocab_rows,
        "phraseRows": phrase_rows,
        "translation": trans_paras,
    }


def parse_table(lines):
    rows = []
    seen_header = False
    for ln in lines:
        s = ln.strip()
        if not s.startswith("|"):
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c.replace(" ", "")) for c in cells if c):
            continue
        if not seen_header:
            seen_header = True
            if cells[:3] in (["单词", "词性", "中文"], ["表达", "意思", "文中出处"]):
                continue
        if any(cells):
            rows.append(cells)
    return rows


def ensure_audio(m, md: Path) -> None:
    stem = m["stem"]
    full_src = md.with_suffix(".mp3")
    full_dst = AUDIO_DIR / f"{stem}_full.mp3"
    m["audioFull"] = None
    if full_src.exists():
        copy_if_missing(full_src, full_dst)
        m["audioFull"] = f"audio/{full_dst.name}"
    else:
        log(f"警告：{stem} 缺少整篇音频，网页将无整篇播放")

    paras = m["rawParagraphs"]
    seg_list = []
    for i, text in enumerate(paras, 1):
        dst = AUDIO_DIR / f"{stem}_p{i}.mp3"
        info = {"audio": None}
        if dst.exists() and dst.stat().st_size > 0:
            info["audio"] = f"audio/{dst.name}"
        else:
            if dst.exists():
                dst.unlink()
            plain = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
            try:
                synth_speech(plain, dst)
                info["audio"] = f"audio/{dst.name}"
                log(f"已合成分段音频：{dst.name}")
            except Exception as exc:  # noqa: BLE001
                if dst.exists():
                    dst.unlink()
                log(f"警告：第 {i} 段音频合成失败（{exc}），该段仅显示文字")
        seg_list.append(info)
    m["segments"] = seg_list

    # 逐句音频（精听模式用），并清理超出当前句数的旧文件
    for i, item in enumerate(m["sentences"], 1):
        dst = AUDIO_DIR / f"{stem}_s{i:02d}.mp3"
        if not (dst.exists() and dst.stat().st_size > 0):
            if dst.exists():
                dst.unlink()
            try:
                synth_speech(item["text"], dst)
            except Exception as exc:  # noqa: BLE001
                raise ValueError(f"{stem}：第 {i} 句音频合成失败：{exc}")
        if not (dst.exists() and dst.stat().st_size > 0):
            raise ValueError(f"{stem}：第 {i} 句音频缺失")
        item["audio"] = f"audio/{dst.name}"
    keep = {f"{stem}_s{i:02d}.mp3" for i in range(1, len(m["sentences"]) + 1)}
    for old in AUDIO_DIR.glob(f"{stem}_s*.mp3"):
        if old.name not in keep:
            old.unlink()


def copy_if_missing(src: Path, dst: Path) -> None:
    if not dst.exists():
        dst.write_bytes(src.read_bytes())


def synth_speech(text: str, dst: Path) -> None:
    import asyncio
    import edge_tts

    async def run(proxy):
        com = edge_tts.Communicate(text, VOICE, proxy=proxy)
        await com.save(str(dst))

    last_error = None
    for proxy in (PROXY, None):
        try:
            asyncio.run(run(proxy))
            return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
    raise last_error


def collect_mds():
    found = []
    for sub in sorted(ROOT_DIR.iterdir()):
        if sub.is_dir() and re.fullmatch(r"\d{4}-\d{2}-\d{2}", sub.name):
            found.extend(sorted(sub.glob("*.md")))
    found.extend(sorted(p for p in ROOT_DIR.glob("*.md") if p.name not in ("README.md", "README-site.md")))
    uniq, seen = [], set()
    for p in sorted(found, key=str):
        key = str(p.resolve())
        if key not in seen:
            seen.add(key)
            uniq.append(p)
    return uniq


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    mds = collect_mds()
    if not mds:
        sys.exit("没有找到 md 源稿")

    materials = []
    for md in mds:
        log(f"解析：{md.name}")
        m = parse_md(md)
        ensure_audio(m, md)
        m.pop("rawParagraphs", None)
        m["vocabCount"] = len(m["vocabRows"])
        materials.append(m)

    materials.sort(key=lambda x: (x["date"], x["num"]), reverse=True)
    payload = {"materials": materials}
    fd, tmp = tempfile.mkstemp(dir=str(WEB_DIR), suffix=".json", prefix="materials_")
    try:
        with open(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        Path(tmp).replace(OUT_JSON)
    except Exception:
        try:
            Path(tmp).unlink()
        except OSError:
            pass
        raise
    log(f"已生成：{OUT_JSON}（共 {len(materials)} 篇）")


if __name__ == "__main__":
    main()
