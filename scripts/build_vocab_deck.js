#!/usr/bin/env node
/**
 * 生词复习库生成器
 *
 * 输入 A：..\..\模拟卷\**\今日生词.md   —— 六级复盘生词卡（表格按所属小节分类）
 * 输入 B：web\materials.json            —— 影子跟读 13 篇的 vocabRows / phraseRows
 * 输入 C：..\..\docs\生词_音标库.json     —— 词形 → IPA（由 build_ipa.py 生成 + 手工补专名）
 * 输出：   web\vocab.json               —— 复习页数据（随站点一起上线）
 *
 * 用法：
 *   node scripts\build_vocab_deck.js
 *   node scripts\build_vocab_deck.js --check   # 只校验不写文件
 *
 * 硬断言（任一不达标即退出码 1，不产出半成品）：
 *   1. 总卡数 ≥ 300；
 *   2. 每张卡都有 term，且 id 唯一；
 *   3. 每张卡至少有 en 或 example 之一（否则复习页背面是空的）；
 *   4. 今日生词卡里的每一张表，其小节标题都能映射到类别；
 *   5. 词性全部能归一化成英文缩写（中文词性必须命中映射表）。
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MOCK_DIR = path.resolve(ROOT, "..", "模拟卷");
const MATERIALS_FILE = path.join(ROOT, "web", "materials.json");
const IPA_FILE = path.resolve(ROOT, "..", "docs", "生词_音标库.json");
const OUT_FILE = path.join(ROOT, "web", "vocab.json");
const CHECK_ONLY = process.argv.includes("--check");

const RANK = { wrong: 1, keyphrase: 2, bank: 3, shadow: 4 };

/** 中文词性 → 英文缩写 */
const POS_CN = {
  名词: "n.",
  动词: "v.",
  形容词: "adj.",
  副词: "adv.",
  介词: "prep.",
  连词: "conj.",
  代词: "pron.",
  数词: "num.",
  短语: "phrase",
  词组: "phrase",
};

/**
 * 小节标题 → 类别。顺序即优先级，先命中先算。
 * 未命中直接抛错——宁可停在这一步，也不要把词按错的优先级排进队列。
 */
const HEADING_RULES = [
  [/句式|搭配/, { bucket: "keyphrase", type: "pattern" }],
  [/用错的词|用错|听力生词|听错|漏听|没听住|错词|错空|错题/, { bucket: "wrong", type: "word" }],
  [/答对的词|答对/, { bucket: "bank", type: "word" }],
  [/题目给的|词库/, { bucket: "bank", type: "word" }],
  [/必背|术语/, { bucket: "keyphrase", type: "word" }],
];

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function fail(msg) {
  console.error("[FAIL] " + msg);
  process.exit(1);
}

/* ---------------- 词形标准化 ---------------- */

function cleanTerm(raw) {
  return String(raw || "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/^[A-O]\)\s*/, "")
    .trim();
}

function slug(term) {
  return String(term)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normPos(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^[\x20-\x7E]+$/.test(s)) return s; // 已是英文缩写
  const parts = s.split(/[/、,，]/).map((x) => x.trim()).filter(Boolean);
  const mapped = parts.map((p) => POS_CN[p]);
  if (mapped.some((x) => !x)) return s; // 未命中，留给断言报错
  return mapped.join("/");
}

/* ---------------- Markdown 表格解析 ---------------- */

function splitRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => s.trim());
}

function isSeparator(line) {
  return !!line && /^\|[\s:|-]+\|$/.test(line.trim());
}

function parseTables(text) {
  const lines = text.split(/\r?\n/);
  const tables = [];
  let heading = "";
  let i = 0;
  while (i < lines.length) {
    const h = /^#{2,3}\s+(.*)$/.exec(lines[i].trim());
    if (h) {
      heading = h[1].trim();
      i += 1;
      continue;
    }
    if (lines[i].trim().startsWith("|") && isSeparator(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const rows = [];
      let k = i + 2;
      while (k < lines.length && lines[k].trim().startsWith("|")) {
        const cells = splitRow(lines[k]);
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) rows.push(cells);
        k += 1;
      }
      tables.push({ heading, header, rows });
      i = k;
      continue;
    }
    i += 1;
  }
  return tables;
}

/** 按列名取列号；先精确匹配，再宽松包含，并排除干扰列（如「词性」「英文释义」都含「词」） */
function pickColumn(header, names, exclude) {
  for (const n of names) {
    const idx = header.indexOf(n);
    if (idx >= 0) return idx;
  }
  for (const n of names) {
    const idx = header.findIndex(
      (cell) => cell.includes(n) && !(exclude || []).some((x) => cell.includes(x))
    );
    if (idx >= 0) return idx;
  }
  return -1;
}

function classifyHeading(heading) {
  for (const [re, cls] of HEADING_RULES) {
    if (re.test(heading)) return cls;
  }
  return null;
}

const PLACEHOLDER_RE = /批改后回填/;

/* ---------------- 输入 A：六级复盘生词卡 ---------------- */

function findCardFiles() {
  if (!fs.existsSync(MOCK_DIR)) fail("找不到模拟卷目录：" + MOCK_DIR);
  const files = [];
  const pushIfCard = (dir) => {
    const f = path.join(dir, "今日生词.md");
    if (fs.existsSync(f)) files.push(f);
  };
  for (const e of fs.readdirSync(MOCK_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = path.join(MOCK_DIR, e.name);
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.name)) {
      pushIfCard(full);
      continue;
    }
    for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
      if (sub.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(sub.name)) pushIfCard(path.join(full, sub.name));
    }
  }
  return files.sort();
}

function cardsFromMockCards() {
  const cards = [];
  const files = findCardFiles();
  for (const file of files) {
    const date = path.basename(path.dirname(file));
    const tables = parseTables(read(file));
    if (!tables.length) fail(`${date} 的今日生词.md 里一张表都没解析到`);
    for (const t of tables) {
      const cls = classifyHeading(t.heading);
      if (!cls) fail(`无法归类的小节标题：${date} / 「${t.heading}」`);
      const iTerm = pickColumn(t.header, ["词/短语", "句式/搭配", "单词", "表达", "词"], ["词性", "释义"]);
      if (iTerm < 0) fail(`${date} /「${t.heading}」的表头没有可用的词列：${t.header.join(" | ")}`);
      const iPos = pickColumn(t.header, ["词性"]);
      const iEn = pickColumn(t.header, ["英文释义"]);
      const iCn = pickColumn(t.header, ["中文释义", "意思", "用途"]);
      const iEx = pickColumn(t.header, ["例句"]);
      const iTag = pickColumn(t.header, ["题号"]);
      for (const cells of t.rows) {
        const term = cleanTerm(cells[iTerm]);
        if (!term || PLACEHOLDER_RE.test(term)) continue;
        cards.push({
          term,
          type: cls.type,
          pos: normPos(iPos >= 0 ? cells[iPos] : ""),
          en: (iEn >= 0 ? cells[iEn] : "").trim(),
          cn: (iCn >= 0 ? cells[iCn] : "").trim(),
          example: (iEx >= 0 ? cells[iEx] : "").trim(),
          bucket: cls.bucket,
          date,
          tag: (iTag >= 0 ? cells[iTag] : "").trim(),
        });
      }
    }
  }
  return cards;
}

/* ---------------- 输入 B：影子跟读词表与短语 ---------------- */

function cardsFromMaterials() {
  const raw = read(MATERIALS_FILE);
  if (!raw) fail("找不到 " + MATERIALS_FILE + "（先跑 build_site.py 生成物料数据）");
  const data = JSON.parse(raw);
  const materials = Array.isArray(data) ? data : data.materials;
  const cards = [];
  for (const m of materials) {
    for (const row of m.vocabRows || []) {
      cards.push({
        term: cleanTerm(row[0]),
        type: "word",
        pos: normPos(row[1]),
        en: String(row[3] || "").trim(),
        cn: String(row[2] || "").trim(),
        example: "",
        bucket: "shadow",
        date: m.date,
        tag: `影子跟读${m.num}`,
      });
    }
    for (const row of m.phraseRows || []) {
      cards.push({
        term: cleanTerm(row[0]),
        type: "phrase",
        pos: "phrase",
        en: "",
        cn: String(row[1] || "").trim(),
        example: String(row[2] || "").trim(),
        bucket: "shadow",
        date: m.date,
        tag: `影子跟读${m.num}`,
      });
    }
  }
  return cards;
}

/* ---------------- 合并（同一词形只留一张卡） ---------------- */

function mergeCards(all) {
  const byId = new Map();
  for (const c of all) {
    const id = slug(c.term);
    if (!id) fail(`词形无法生成 id：「${c.term}」`);
    const cur = byId.get(id);
    if (!cur) {
      byId.set(id, { ...c, id, firstDate: c.date });
      continue;
    }
    const better = RANK[c.bucket] < RANK[cur.bucket];
    const win = better ? c : cur;
    const lose = better ? cur : c;
    const type = win.type === "pattern" || lose.type === "pattern" ? "pattern" : win.type;
    byId.set(id, {
      id,
      term: win.term || lose.term,
      type,
      pos: win.pos || lose.pos,
      en: win.en || lose.en,
      cn: win.cn || lose.cn,
      example: win.example || lose.example,
      bucket: win.bucket,
      date: c.date > cur.date ? c.date : cur.date,
      firstDate: c.date < cur.firstDate ? c.date : cur.firstDate,
      tag: win.tag || lose.tag,
    });
  }
  return [...byId.values()].sort(
    (a, b) =>
      RANK[a.bucket] - RANK[b.bucket] ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      a.id.localeCompare(b.id)
  );
}

/* ---------------- 音标（docs\生词_音标库.json） ---------------- */

function loadIpa() {
  try {
    return JSON.parse(read(IPA_FILE)).words || {};
  } catch (err) {
    return {};
  }
}

/** 词条 → IPA：短语按词拆开逐词拼；只要有一个词缺音标就整条留空（半截音标会误导） */
function ipaFor(term, ipaWords) {
  const parts = [];
  String(term)
    .toLowerCase()
    .replace(/[^a-z'\-\s]+/g, " ")
    .split(/\s+/)
    .forEach(function (chunk) {
      chunk.split("-").forEach(function (piece) {
        const w = piece.replace(/^'+|'+$/g, "");
        if (w) parts.push(ipaWords[w] || "");
      });
    });
  if (!parts.length || parts.some((x) => !x)) return "";
  return parts.join(" ");
}

function attachIpa(cards) {
  const ipaWords = loadIpa();
  let covered = 0;
  let counted = 0;
  const missing = [];
  for (const c of cards) {
    if (c.type === "pattern") {
      // 句式卡是句型模板（常含中文与整句），给整句标音只会误导，统一留空
      c.ipa = "";
      continue;
    }
    c.ipa = ipaFor(c.term, ipaWords);
    counted += 1;
    if (c.ipa) covered += 1;
    else missing.push(c.term);
  }
  return { covered: covered, counted: counted, missing: missing };
}

/* ---------------- 断言与输出 ---------------- */

function validate(cards) {
  const problems = [];
  if (cards.length < 300) problems.push(`总卡数只有 ${cards.length} 张（门槛 300）`);
  const ids = new Set();
  const badPos = new Set();
  for (const c of cards) {
    if (!c.term) problems.push("存在没有 term 的卡片");
    if (ids.has(c.id)) problems.push("id 重复：" + c.id);
    ids.add(c.id);
    if (!c.en && !c.example) problems.push(`「${c.term}」既没有英文释义也没有例句，背面会是空的`);
    if (c.pos && /[\u4e00-\u9fa5]/.test(c.pos)) badPos.add(`${c.term} → ${c.pos}`);
    if (!RANK[c.bucket]) problems.push(`「${c.term}」的类别非法：${c.bucket}`);
  }
  if (badPos.size) problems.push("词性未归一化：" + [...badPos].join("；"));
  return problems;
}

function main() {
  const mock = cardsFromMockCards();
  const shadow = cardsFromMaterials();
  const cards = mergeCards([...mock, ...shadow]);
  const ipaStat = attachIpa(cards);
  const problems = validate(cards);
  if (problems.length) {
    console.error("[FAIL] 词库校验未通过：");
    problems.slice(0, 20).forEach((p) => console.error("  - " + p));
    process.exit(1);
  }

  const byBucket = {};
  const byType = {};
  for (const c of cards) {
    byBucket[c.bucket] = (byBucket[c.bucket] || 0) + 1;
    byType[c.type] = (byType[c.type] || 0) + 1;
  }
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString().slice(0, 19),
    stats: {
      total: cards.length,
      byBucket,
      byType,
      ipa: { covered: ipaStat.covered, counted: ipaStat.counted, missing: ipaStat.missing.length },
      raw: { mock: mock.length, shadow: shadow.length },
    },
    cards,
  };

  console.log(`[OK] 复盘卡 ${mock.length} 条 + 跟读词表 ${shadow.length} 条 → 去重后 ${cards.length} 张`);
  console.log(`     类别：错词 ${byBucket.wrong || 0} / 必背与句式 ${byBucket.keyphrase || 0} / 词库 ${byBucket.bank || 0} / 跟读 ${byBucket.shadow || 0}`);
  console.log(`     形态：单词 ${byType.word || 0} / 短语 ${byType.phrase || 0} / 句式 ${byType.pattern || 0}`);
  const ipaRate = ipaStat.covered / Math.max(1, ipaStat.counted);
  console.log(
    `     音标：${ipaStat.covered} / ${ipaStat.counted} 张（${(ipaRate * 100).toFixed(1)}%；句式卡 ${cards.length - ipaStat.counted} 张不计）`
  );
  if (ipaStat.missing.length) {
    console.log(
      `     没音标的词条 ${ipaStat.missing.length} 个（前 10）：` + ipaStat.missing.slice(0, 10).join(" / ")
    );
  }
  if (ipaRate < 0.9) {
    console.error(
      `[FAIL] 音标覆盖率只有 ${(ipaRate * 100).toFixed(1)}%（门槛 90%）。先补 docs\\生词_音标库.json，或跑 scripts\\build_ipa.py。`
    );
    process.exit(1);
  }

  if (CHECK_ONLY) {
    console.log("     （--check：只校验，未写文件）");
    return;
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 1), "utf8");
  console.log(`     已写入 ${OUT_FILE}`);
}

main();
