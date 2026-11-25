(function () {
  "use strict";

  var DATA_URL = "vocab.json";
  var PROGRESS_KEY = "shadow-vocab-v1";
  var SESSION_KEY = "shadow-vocab-session-v1";
  var LIBRARY_KEY = "shadow-vocab-books-v2";
  var INTERVALS = [1, 3, 7, 16, 35]; // 盒 1..5 对应的天数
  var BOX_LABEL = ["未学", "第 1 盒", "第 2 盒", "第 3 盒", "第 4 盒", "第 5 盒"];
  var BUCKET_LABEL = {
    wrong: "复盘错词",
    keyphrase: "必背与句式",
    bank: "复盘词库",
    shadow: "影子跟读",
  };
  var DEFAULT_SETTINGS = { newLimit: 20, reviewLimit: 40, deepLimit: 10, mode: "deep", modeVersion: 1 };
  var MODE_LABEL = {
    self: "翻面自评",
    mcq: "选择题",
    deep: "三步主动训练",
  };
  var DEEP_STAGE_LABEL = ["看词忆义", "看义说词", "语境使用"];

  var deck = [];
  var builtinCards = [];
  var builtinById = {};
  var library = null;
  var dictionary = null;
  var dictionaryPromise = null;
  var progress = null;
  var root = null;
  var view = "overview";
  var session = null;
  var savedSession = null;
  var filters = { date: "", source: "", queue: "daily" };
  var librarySearch = "";
  var addNotice = "";
  var ttsOk = typeof window !== "undefined" && "speechSynthesis" in window;
  var BOOK_TYPE_LABEL = { word: "单词", phrase: "短语", pattern: "句式" };

  /* ---------------- 小工具 ---------------- */

  function qs(sel) {
    return document.querySelector(sel);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function addDays(dateStr, days) {
    var p = dateStr.split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() + days);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  /** 本地时间戳（YYYY-MM-DDTHH:MM:SS）——不用 toISOString，否则横幅会显示 UTC 时间 */
  function nowStamp() {
    var d = new Date();
    return (
      d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds())
    );
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /* ---------------- 本地存储 ---------------- */

  function defaultProgress() {
    return { updatedAt: "", cards: {}, settings: {} };
  }

  function loadProgress() {
    var raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(PROGRESS_KEY));
    } catch (err) {
      raw = null;
    }
    var data = raw && typeof raw === "object" ? raw : defaultProgress();
    if (!data.cards || typeof data.cards !== "object") data.cards = {};
    data.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
    if (!data.settings.modeVersion) {
      data.settings.mode = "deep";
      data.settings.modeVersion = 1;
    }
    return data;
  }

  function saveProgress() {
    progress.updatedAt = new Date().toISOString().slice(0, 19);
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
    } catch (err) {
      /* 本地存储不可用时静默跳过，页面仍可继续刷 */
    }
  }

  /* ---------------- 生词本 ---------------- */

  function defaultLibrary() {
    return {
      version: 2,
      activeBookId: "inbox",
      books: [
        {
          id: "inbox",
          name: "我的生词本",
          createdAt: nowStamp(),
          source: "custom",
          entries: [],
        },
      ],
    };
  }

  function loadLibrary() {
    var raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(LIBRARY_KEY));
    } catch (err) {
      raw = null;
    }
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.books)) return defaultLibrary();
    raw.books = raw.books.filter(function (book) {
      return book && book.id && book.name && Array.isArray(book.entries);
    });
    if (!raw.books.length) return defaultLibrary();
    if (
      !raw.activeBookId ||
      !raw.books.some(function (book) {
        return book.id === raw.activeBookId;
      })
    ) {
      raw.activeBookId = raw.books[0].id;
    }
    return raw;
  }

  function saveLibrary() {
    library.updatedAt = nowStamp();
    try {
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(library));
    } catch (err) {
      window.alert("生词本保存失败：浏览器本地存储空间可能已满。");
    }
    refreshDeck();
  }

  function findBook(id) {
    if (!library) return null;
    for (var i = 0; i < library.books.length; i++) {
      if (library.books[i].id === id) return library.books[i];
    }
    return null;
  }

  function activeBook() {
    return findBook(library && library.activeBookId) || (library && library.books[0]) || null;
  }

  function refreshDeck() {
    var book = activeBook();
    deck = book
      ? book.entries.map(function (entry) {
          return resolveSelection(entry);
        })
      : [];
  }

  function slug(term) {
    return String(term || "")
      .toLowerCase()
      .replace(/[’]/g, "'")
      .replace(/[^a-z0-9']+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function newBookId() {
    return "book-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1000);
  }

  function normalizeSelection(raw) {
    var term = String(raw.term || "").trim().replace(/\s+/g, " ");
    var type =
      raw.type === "phrase" || raw.type === "pattern"
        ? raw.type
        : /\s/.test(term)
        ? "phrase"
        : "word";
    return {
      term: term,
      type: type,
      addedAt: String(raw.addedAt || nowStamp()),
      override: raw.override && typeof raw.override === "object" ? raw.override : null,
    };
  }

  function dictionaryLookup(term) {
    if (!dictionary || !dictionary.entries) return null;
    var key = String(term || "").trim().toLowerCase();
    if (dictionary.entries[key]) return dictionary.entries[key];
    var compact = key.replace(/[\s-]+/g, " ");
    if (dictionary.entries[compact]) return dictionary.entries[compact];
    var joined = key.replace(/\s+/g, "-");
    if (dictionary.entries[joined]) return dictionary.entries[joined];
    return null;
  }

  function resolveSelection(selection) {
    var raw = normalizeSelection(selection);
    var dict = dictionaryLookup(raw.term);
    var context = builtinById[slug(raw.term)] || null;
    var override = raw.override || {};
    var type = override.type || (dict && dict.type) || (context && context.type) || raw.type;
    return {
      id: slug(raw.term),
      term: raw.term,
      type: type,
      pos: String(override.pos || (dict && dict.pos) || (context && context.pos) || (type === "phrase" ? "phrase" : "")).trim(),
      cn: String(override.cn || (dict && dict.cn) || (context && context.cn) || "").trim(),
      en: String(override.en || (dict && dict.en) || (context && context.en) || "").trim(),
      ipa: String(override.ipa || (dict && dict.ipa) || (context && context.ipa) || "").trim(),
      example: String(override.example || (context && context.example) || "").trim(),
      exchange: String(override.exchange || (dict && dict.exchange) || "").trim(),
      tags: (dict && dict.tags) || [],
      collins: dict && dict.collins,
      oxford: dict && dict.oxford,
      dictionaryMatched: !!dict,
      bucket: "custom",
      date: raw.addedAt.slice(0, 10),
      firstDate: raw.addedAt.slice(0, 10),
      tag: "",
    };
  }

  function loadDictionary() {
    if (dictionary) return Promise.resolve(dictionary);
    if (dictionaryPromise) return dictionaryPromise;
    dictionaryPromise = fetch("dictionary.json", { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        dictionary = data;
        refreshDeck();
        return dictionary;
      })
      .catch(function (err) {
        dictionaryPromise = null;
        throw err;
      });
    return dictionaryPromise;
  }

  function ensureDictionary() {
    return loadDictionary().catch(function (err) {
      window.alert("内置词典加载失败：" + err.message + "。请检查 dictionary.json 是否存在。");
      throw err;
    });
  }

  function createBuiltinBook(kind, terms) {
    var labels = {
      cet4: "四级词汇",
      cet6: "六级完整",
      "cet6-combined": "六级高频合订",
      "cet6-five-year": "六级近五年高频",
      "cet6-compact": "六级真题精简",
      shadow: "影子跟读词库",
      review: "真题复习词库",
    };
    var sourceLabel = labels[kind] || kind;
    var existing = library.books.find(function (b) {
      return b.source === kind;
    });
    if (existing) {
      library.activeBookId = existing.id;
      saveLibrary();
      render();
      window.alert("这本内置书已经添加过了，已切换到「" + existing.name + "」。");
      return;
    }
    if (!terms.length) {
      window.alert("内置书没有可导入的词卡。");
      return;
    }
    var book = {
      id: newBookId(),
      name: sourceLabel,
      createdAt: nowStamp(),
      source: kind,
      entries: terms.map(function (term) {
        return normalizeSelection({ term: term });
      }),
    };
    library.books.push(book);
    library.activeBookId = book.id;
    saveLibrary();
    render();
    if (!dictionary) {
      ensureDictionary()
        .then(function () {
          refreshDeck();
          render();
        })
        .catch(function () {
          /* ensureDictionary 已提示 */
        });
    }
  }

  function importBuiltinBook(kind) {
    if (kind === "shadow" || kind === "review") {
      var terms = builtinCards
        .filter(function (c) {
          return kind === "shadow" ? c.bucket === "shadow" : c.bucket !== "shadow";
        })
        .map(function (c) {
          return c.term;
        });
      createBuiltinBook(kind, terms);
      return;
    }
    fetch("wordbooks/" + kind + ".json", { cache: "no-cache" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        var terms = Array.isArray(data) ? data : data.terms || [];
        createBuiltinBook(kind, terms);
      })
      .catch(function (err) {
        window.alert("词书加载失败：" + err.message);
      });
  }

  /* ---------------- 未完成的一轮（断点续学） ---------------- */

  function readSession() {
    var raw = null;
    try {
      raw = JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch (err) {
      raw = null;
    }
    if (!raw || typeof raw !== "object" || !raw.queueIds || !raw.queueIds.length) return null;
    return raw;
  }

  function writeSession(payload) {
    savedSession = payload;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch (err) {
      /* 忽略 */
    }
  }

  /** 把当前这一轮（只存卡 id）写进存储槽；每次评分 / 翻面 / 作答后都调一次 */
  function persistSession() {
    if (!session) return;
    writeSession({
      version: 1,
      savedAt: nowStamp(),
      startedAt: session.startedAt || nowStamp(),
      kind: session.kind,
      mode: session.mode,
      queueIds: session.queue.map(function (c) {
        return c.id;
      }),
      idx: session.idx,
      round: session.round,
      requeueIds: session.requeue.map(function (c) {
        return c.id;
      }),
      total: session.total,
      stats: session.stats,
      revealed: !!session.revealed,
      showCn: !!session.showCn,
      mcqAnswered: session.mcqAnswered || "",
      mcqOptions: session.mcqOptions || [],
      deepStage: session.deepStage || 1,
      deep: session.deep || null,
    });
  }

  function clearSavedSession() {
    savedSession = null;
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (err) {
      /* 忽略 */
    }
  }

  /* ---------------- 队列与排程 ---------------- */

  function filteredCards() {
    return deck.filter(function (c) {
      if (filters.date && c.date !== filters.date) return false;
      if (filters.source === "review" && c.bucket === "shadow") return false;
      if (filters.source === "shadow" && c.bucket !== "shadow") return false;
      return true;
    });
  }

  function hasCardContent(card) {
    return !!(card && (card.cn || card.en || card.example));
  }

  function cardState(c) {
    var rec = progress.cards[c.id];
    if (!rec) return "new";
    if (rec.due && rec.due <= todayStr()) return "due";
    return "later";
  }

  /** 记下"今天动过这张卡"和先后顺序，供「今日复习」按原顺序再刷一遍 */
  function markTouchedToday(id) {
    var today = todayStr();
    if (!progress.today || progress.today.date !== today || !Array.isArray(progress.today.ids)) {
      progress.today = { date: today, ids: [] };
    }
    if (progress.today.ids.indexOf(id) === -1) progress.today.ids.push(id);
  }

  function todayQueueIds() {
    var today = todayStr();
    if (progress.today && progress.today.date === today && Array.isArray(progress.today.ids)) {
      return progress.today.ids.slice();
    }
    return [];
  }

  /** 「今日复习」＝今天动过的卡，按今天刷的顺序；顺序记录缺失时退回"最后动过的日期＝今天" */
  function todayCards(pool) {
    var byId = {};
    pool.forEach(function (c) {
      byId[c.id] = c;
    });
    var queue = todayQueueIds()
      .map(function (id) {
        return byId[id];
      })
      .filter(Boolean);
    if (queue.length) return queue;
    var today = todayStr();
    return pool.filter(function (c) {
      var rec = progress.cards[c.id];
      return rec && rec.lastAt === today;
    });
  }

  function makeQueue(kind, mode) {
    var pool = filteredCards().filter(hasCardContent);
    var due = [];
    var fresh = [];
    var wrong = [];
    pool.forEach(function (c) {
      var st = cardState(c);
      if (st === "new") fresh.push(c);
      if (st === "due") due.push(c);
      var rec = progress.cards[c.id];
      if (rec && (rec.box || 0) <= 1 && (rec.no || 0) > 0) wrong.push(c);
    });
    due.sort(function (a, b) {
      return (progress.cards[a.id].box || 0) - (progress.cards[b.id].box || 0);
    });
    var queue;
    if (kind === "due") queue = due.slice(0, progress.settings.reviewLimit);
    else if (kind === "new") queue = fresh.slice(0, progress.settings.newLimit);
    else if (kind === "wrong") queue = wrong;
    else if (kind === "today") queue = todayCards(pool);
    else queue = due.slice(0, progress.settings.reviewLimit).concat(fresh.slice(0, progress.settings.newLimit));
    if (mode === "deep") {
      var cap = Math.max(1, progress.settings.deepLimit || DEFAULT_SETTINGS.deepLimit);
      if (kind === "daily") {
        var mixed = due.slice(0, cap);
        mixed = mixed.concat(fresh.slice(0, Math.max(0, cap - mixed.length)));
        queue = mixed;
      } else {
        queue = queue.slice(0, cap);
      }
    }
    if (mode === "mcq") {
      queue = queue.filter(function (c) {
        return !!c.en;
      });
    }
    return queue;
  }

  function computeSummary() {
    var pool = filteredCards();
    var s = {
      total: pool.length,
      due: 0,
      fresh: 0,
      mastered: 0,
      learning: 0,
      meaning: 0,
      recall: 0,
      use: 0,
      loop: 0,
    };
    pool.forEach(function (c) {
      var st = cardState(c);
      if (st === "new") s.fresh += 1;
      if (st === "due") s.due += 1;
      var rec = progress.cards[c.id];
      if (rec && (rec.box || 0) >= 4) s.mastered += 1;
      else if (rec) s.learning += 1;
      var skills = rec && rec.skills;
      if (skills && skills.meaning === "know") s.meaning += 1;
      if (skills && skills.recall === "right") s.recall += 1;
      if (skills && skills.use === "right") s.use += 1;
      if (
        skills &&
        skills.meaning === "know" &&
        skills.recall === "right" &&
        skills.use === "right"
      ) {
        s.loop += 1;
      }
    });
    return s;
  }

  function applyRating(card, rating) {
    var today = todayStr();
    var rec = progress.cards[card.id] || { box: 0, seen: 0, know: 0, fuzzy: 0, no: 0 };
    rec.seen = (rec.seen || 0) + 1;
    if (rating === "know") {
      rec.know = (rec.know || 0) + 1;
      rec.box = Math.min(INTERVALS.length, (rec.box || 0) + 1);
      rec.due = addDays(today, INTERVALS[rec.box - 1]);
    } else if (rating === "fuzzy") {
      rec.fuzzy = (rec.fuzzy || 0) + 1;
      rec.box = Math.max(1, rec.box || 1);
      rec.due = addDays(today, INTERVALS[0]);
    } else {
      rec.no = (rec.no || 0) + 1;
      rec.box = 1;
      rec.due = addDays(today, INTERVALS[0]);
    }
    rec.lastAt = today;
    progress.cards[card.id] = rec;
    markTouchedToday(card.id);
    saveProgress();
  }

  /* ---------------- 发音 ---------------- */

  function speak(text) {
    if (!ttsOk) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text).replace(/[`*]/g, ""));
      u.lang = "en-US";
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (err) {
      /* 忽略 */
    }
  }

  /* ---------------- 三步主动训练 ---------------- */

  function emptyDeepState() {
    return {
      meaning: "",
      recallAnswer: "",
      recallChecked: false,
      recallCorrect: null,
      useAnswer: "",
      useChecked: false,
      useCorrect: null,
    };
  }

  function normalizeEnglish(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[“”"]/g, "")
      .replace(/[.!?;:,，。！？；：()[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function answerVariants(term) {
    return String(term || "")
      .split(/\s*\/\s*|\s+or\s+/i)
      .map(normalizeEnglish)
      .filter(Boolean);
  }

  function answersMatch(card, answer, expected) {
    var got = normalizeEnglish(answer);
    if (!got) return false;
    var wanted = expected ? [normalizeEnglish(expected)] : answerVariants(card.term);
    for (var i = 0; i < wanted.length; i++) {
      if (got === wanted[i]) return true;
      if (
        card.type === "word" &&
        got.replace(/(ing|ed|es|s)$/, "") === wanted[i].replace(/(ing|ed|es|s)$/, "")
      ) {
        return true;
      }
    }
    return false;
  }

  function answerUsesExpression(card, answer) {
    var got = normalizeEnglish(answer);
    if (!got) return false;
    var variants = answerVariants(card.term);
    for (var i = 0; i < variants.length; i++) {
      if (got.indexOf(variants[i]) >= 0) return true;
    }
    var ignored = {
      a: 1, an: 1, the: 1, be: 1, is: 1, are: 1, was: 1, were: 1, am: 1,
      to: 1, of: 1, in: 1, on: 1, at: 1, for: 1, from: 1, with: 1, that: 1,
      this: 1, it: 1, one: 1, ones: 1, sb: 1, sth: 1, somebody: 1, something: 1,
    };
    var tokens = normalizeEnglish(card.term)
      .split(" ")
      .filter(function (w) {
        return w && !ignored[w] && w !== "a" && w !== "b" && w !== "c";
      });
    if (!tokens.length) return got.indexOf(normalizeEnglish(card.term)) >= 0;
    return tokens.every(function (w) {
      return got.indexOf(w) >= 0;
    });
  }

  function makeCloze(card) {
    var source = String(card.example || "").trim();
    if (!source) return null;
    var variants = answerVariants(card.term);
    for (var i = 0; i < variants.length; i++) {
      var escaped = variants[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var re = new RegExp("(^|[^a-z])(" + escaped + ")([^a-z]|$)", "i");
      if (re.test(source)) {
        return {
          sentence: source.replace(re, function (_, before, target, after) {
            return before + "________" + after;
          }),
          answer: source.match(re)[2],
        };
      }
    }
    return null;
  }

  function saveDeepSkills(card) {
    var rec = progress.cards[card.id] || { box: 0, seen: 0, know: 0, fuzzy: 0, no: 0 };
    rec.skills = {
      meaning: session.deep.meaning || "no",
      recall: session.deep.recallCorrect ? "right" : "wrong",
      use: session.deep.useCorrect ? "right" : "wrong",
      lastAt: todayStr(),
    };
    progress.cards[card.id] = rec;
  }

  /* ---------------- 复习会话 ---------------- */

  function startSession(kind, mode) {
    var queue = makeQueue(kind, mode);
    if (!queue.length) {
      var why =
        kind === "due"
          ? "今天没有到期的复习卡。"
          : kind === "new"
          ? "没有新词了。"
          : kind === "wrong"
          ? "没有需要重刷的错词。"
          : kind === "today"
          ? "今天还没有刷过卡。「今日复习」是把今天刷过的再刷一遍。"
          : "今天的到期复习与新词都已经刷完了。";
      window.alert(why + "（可以换一个队列，或点「只刷新词」继续推新词。）");
      return;
    }
    session = {
      kind: kind,
      mode: mode,
      startedAt: nowStamp(),
      queue: queue,
      total: queue.length,
      idx: 0,
      round: 1,
      requeue: [],
      stats: { know: 0, fuzzy: 0, no: 0 },
      revealed: false,
      showCn: false,
      mcqAnswered: "",
      mcqOptions: [],
      deepStage: 1,
      deep: emptyDeepState(),
    };
    view = "session";
    persistSession();
    render();
  }

  function currentCard() {
    return session.queue[session.idx];
  }

  function rate(rating) {
    var card = currentCard();
    if (!card) return;
    if (session.mode === "deep") saveDeepSkills(card);
    applyRating(card, rating);
    session.stats[rating] += 1;
    if (rating === "no") session.requeue.push(card);
    advance();
  }

  function advance() {
    session.idx += 1;
    session.revealed = false;
    session.showCn = false;
    session.mcqAnswered = "";
    session.mcqOptions = [];
    session.deepStage = 1;
    session.deep = emptyDeepState();
    if (session.idx >= session.queue.length) {
      if (session.round === 1 && session.requeue.length) {
        session.round = 2;
        session.queue = session.requeue;
        session.requeue = [];
        session.idx = 0;
        persistSession();
      } else {
        clearSavedSession(); // 这一轮真的刷完了，没有要续的
        view = "done";
      }
    } else {
      persistSession();
    }
    render();
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    if (!root) return;
    root.innerHTML = "";
    if (view === "session") {
      root.appendChild(renderSessionHead());
      root.appendChild(renderCardBox());
      return;
    }
    if (view === "done") {
      root.appendChild(renderDone());
      return;
    }
    if (view === "add") {
      root.appendChild(renderAddEntry());
      return;
    }
    root.appendChild(renderLibrary());
    root.appendChild(renderSummary());
    if (savedSession) root.appendChild(renderResume());
    root.appendChild(renderStart());
    root.appendChild(renderBookEntries());
    root.appendChild(renderLog());
    root.appendChild(renderManage());
  }

  function renderLibrary() {
    var book = activeBook();
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", "六级生词本"));
    card.appendChild(
      el(
        "p",
        "note",
        "默认从空白开始。推荐使用「六级高频合订」：先学近五年高频，再补真题精简扩展词。"
      )
    );

    var row = el("div", "vrow");
    row.appendChild(el("span", "vrow-label", "当前书本"));
    var select = el("select", "vselect");
    library.books.forEach(function (item) {
      var opt = el("option", null, item.name + "（" + item.entries.length + "）");
      opt.value = item.id;
      select.appendChild(opt);
    });
    select.value = book ? book.id : "";
    select.addEventListener("change", function () {
      library.activeBookId = select.value;
      saveLibrary();
      librarySearch = "";
      render();
    });
    row.appendChild(select);
    var add = el("button", "btn btn-primary vpick", "添加单词 / 短语");
    add.addEventListener("click", function () {
      addNotice = "";
      view = "add";
      render();
    });
    row.appendChild(add);
    var blank = el("button", "btn btn-ghost vpick", "新建空白本");
    blank.addEventListener("click", function () {
      var name = window.prompt("新词本名称", "我的英语表达");
      if (!name || !name.trim()) return;
      var created = {
        id: newBookId(),
        name: name.trim().slice(0, 30),
        createdAt: nowStamp(),
        source: "custom",
        entries: [],
      };
      library.books.push(created);
      library.activeBookId = created.id;
      saveLibrary();
      render();
    });
    row.appendChild(blank);
    card.appendChild(row);

    if (!book || !book.entries.length) {
      var empty = el("p", "note");
      empty.textContent = "当前生词本是空的。可以直接添加你正在遇到的词，也可以先加入一本内置词书。";
      card.appendChild(empty);
    }

    var builtinTitle = el("p", "vlib-subtitle", "六级词书");
    card.appendChild(builtinTitle);
    var builtin = el("div", "actions");
    [
      ["cet6-combined", "六级高频合订（1074，推荐）"],
      ["cet6", "六级完整"],
    ].forEach(function (pair) {
      var exists = library.books.some(function (item) {
        return item.source === pair[0];
      });
      var button = el(
        "button",
        "btn " + (pair[0] === "cet6-combined" && !exists ? "btn-primary" : "btn-ghost") + " vpick",
        (exists ? "✓ " : "") + pair[1]
      );
      button.addEventListener("click", function () {
        importBuiltinBook(pair[0]);
      });
      builtin.appendChild(button);
    });
    card.appendChild(builtin);
    card.appendChild(
      el(
        "p",
        "note",
        "「六级高频合订」= 近五年真题高频 361 词 + 真题精简中未重复的 713 词，共 1,074 词，按优先级排序。" +
          "词典来自 ECDICT（MIT）" +
          (dictionary ? "共 " + dictionary.count.toLocaleString("zh-CN") + " 条" : "") +
          "，按需加载。"
      )
    );
    return card;
  }

  function addWordToActiveBook(term, type) {
    var book = activeBook();
    if (!book) return;
    var clean = String(term || "").trim().replace(/\s+/g, " ");
    if (!clean) {
      addNotice = "请输入单词或短语。";
      render();
      return;
    }
    var key = clean.toLowerCase();
    var duplicate = book.entries.some(function (entry) {
      return String(entry.term || "").trim().toLowerCase() === key;
    });
    if (duplicate) {
      addNotice = "「" + clean + "」已经在当前生词本里了。";
      render();
      return;
    }
    var selection = normalizeSelection({ term: clean, type: type === "auto" ? undefined : type });
    var resolved = resolveSelection(selection);
    if (!resolved.dictionaryMatched && !resolved.cn && !resolved.en) {
      if (
        !window.confirm(
          "内置词典和现有文章都没有收录「" +
            clean +
            "」。仍然加入为待补词条吗？\n（练习时会提示待补，不会伪造释义。）"
        )
      ) {
        return;
      }
    }
    selection.addedAt = nowStamp();
    book.entries.push(selection);
    saveLibrary();
    addNotice = resolved.dictionaryMatched
      ? "已加入「" + clean + "」，词典信息已自动补全。"
      : resolved.cn || resolved.en
      ? "已加入「" + clean + "」，释义和例句来自本站文章词库。"
      : "已加入「" + clean + "」，目前标记为待补词条。";
    render();
  }

  function renderAddEntry() {
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", "添加单词 / 短语"));
    var book = activeBook();
    card.appendChild(el("p", "note", "加入当前书本：" + (book ? book.name : "未选择")));
    if (!dictionary && !dictionaryPromise) {
      loadDictionary()
        .then(function () {
          if (view === "add") render();
        })
        .catch(function () {
          /* ensureDictionary 会在提交时给出提示 */
        });
    }

    var form = el("div", "vadd-form");
    var termLabel = el("label", "vfield");
    termLabel.appendChild(el("span", "vfield-label", "词或短语"));
    var termInput = document.createElement("input");
    termInput.className = "vselect vadd-input";
    termInput.type = "text";
    termInput.placeholder = "例如 postpone / deal with / be likely to";
    termInput.autocomplete = "off";
    termInput.spellcheck = false;
    termLabel.appendChild(termInput);
    form.appendChild(termLabel);

    var typeLabel = el("label", "vfield");
    typeLabel.appendChild(el("span", "vfield-label", "类型"));
    var typeSelect = el("select", "vselect vadd-input");
    [
      ["auto", "自动判断"],
      ["word", "单词"],
      ["phrase", "短语"],
      ["pattern", "句式"],
    ].forEach(function (pair) {
      var opt = el("option", null, pair[1]);
      opt.value = pair[0];
      typeSelect.appendChild(opt);
    });
    typeLabel.appendChild(typeSelect);
    form.appendChild(typeLabel);
    card.appendChild(form);

    var status = el(
      "p",
      "note",
      dictionary ? "词典已就绪，共 " + dictionary.count + " 个四、六级词条。" : "正在加载内置词典…"
    );
    card.appendChild(status);
    if (addNotice) card.appendChild(el("p", "vadd-notice", addNotice));
    var actions = el("div", "actions");
    var submit = el("button", "btn btn-primary", "查词典并加入");
    submit.addEventListener("click", function () {
      submit.disabled = true;
      ensureDictionary()
        .then(function () {
          addWordToActiveBook(termInput.value, typeSelect.value);
        })
        .catch(function () {
          submit.disabled = false;
        });
    });
    termInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") submit.click();
    });
    var back = el("button", "btn btn-ghost", "返回生词本");
    back.addEventListener("click", function () {
      view = "overview";
      addNotice = "";
      render();
    });
    actions.appendChild(submit);
    actions.appendChild(back);
    card.appendChild(actions);
    return card;
  }

  function renderBookEntries() {
    var book = activeBook();
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", "生词本内容"));
    if (!book || !book.entries.length) {
      card.appendChild(el("p", "note", "还没有词。点上方「添加单词 / 短语」，或加入一本内置词书。"));
      return card;
    }

    var row = el("div", "vrow");
    var search = document.createElement("input");
    search.className = "search-input";
    search.type = "search";
    search.placeholder = "搜索当前生词本";
    search.value = librarySearch;
    search.addEventListener("input", function () {
      librarySearch = search.value;
      render();
      var next = qs(".vbook-search");
      if (next) {
        next.focus();
        next.setSelectionRange(next.value.length, next.value.length);
      }
    });
    search.classList.add("vbook-search");
    row.appendChild(search);
    card.appendChild(row);

    var query = librarySearch.trim().toLowerCase();
    var matches = book.entries.filter(function (entry) {
      if (!query) return true;
      if (String(entry.term || "").toLowerCase().indexOf(query) >= 0) return true;
      var resolved = resolveSelection(entry);
      return String(resolved.cn || "").toLowerCase().indexOf(query) >= 0;
    });
    var limit = 50;
    card.appendChild(
      el(
        "p",
        "note",
        "当前 " + book.entries.length + " 个词条" +
          (query ? "，匹配 " + matches.length + " 个" : "") +
          (matches.length > limit ? "；下面先显示前 " + limit + " 个。" : "。")
      )
    );
    var list = el("div", "vbook-list");
    matches.slice(0, limit).forEach(function (entry) {
      var resolved = resolveSelection(entry);
      var item = el("div", "vbook-row");
      var main = el("div", "vbook-main");
      var title = el("div", "vbook-term", resolved.term);
      title.appendChild(el("span", "vbook-type", BOOK_TYPE_LABEL[resolved.type] || "单词"));
      main.appendChild(title);
      var detail = resolved.cn || resolved.en || "词典待补";
      main.appendChild(el("div", "vbook-cn", detail.split("\n")[0]));
      var del = el("button", "btn btn-ghost vbook-del", "删除");
      del.addEventListener("click", function () {
        if (!window.confirm("从「" + book.name + "」删除「" + resolved.term + "」？")) return;
        book.entries = book.entries.filter(function (candidate) {
          return candidate !== entry;
        });
        saveLibrary();
        render();
      });
      item.appendChild(main);
      item.appendChild(del);
      list.appendChild(item);
    });
    card.appendChild(list);
    return card;
  }

  function statChip(label, value) {
    var box = el("div", "vstat");
    box.appendChild(el("span", "vstat-num", String(value)));
    box.appendChild(el("span", "vstat-label", label));
    return box;
  }

  function fmtStamp(iso) {
    if (!iso) return "";
    return String(iso).replace("T", " ").slice(5, 16); // MM-DD HH:MM
  }

  function modeLabel(mode) {
    return MODE_LABEL[mode] || MODE_LABEL.self;
  }

  /* ---------------- 断点续学：横幅 + 恢复 ---------------- */

  function sessionPosLabel(s) {
    var len = (s.queueIds || []).length;
    var idx = Math.min(Math.max(0, s.idx || 0), Math.max(0, len - 1)) + 1;
    return (s.round === 2 ? "错词重考 " : "第 ") + idx + " / " + len + " 张";
  }

  function renderResume() {
    var s = savedSession;
    var card = el("section", "card vresume");
    card.appendChild(el("h2", "section-title", "上次没刷完"));
    var stats = s.stats || { know: 0, fuzzy: 0, no: 0 };
    card.appendChild(
      el(
        "p",
        "vresume-line",
        sessionPosLabel(s) + " · " + queueLabel(s.kind) + " · " + modeLabel(s.mode) +
          " · " + fmtStamp(s.startedAt || s.savedAt) + " 开始" +
          " · 认识 " + (stats.know || 0) + " / 模糊 " + (stats.fuzzy || 0) + " / 不认识 " + (stats.no || 0)
      )
    );
    var actions = el("div", "actions");
    var go = el("button", "btn btn-primary", "继续");
    go.addEventListener("click", resumeSession);
    var drop = el("button", "btn btn-ghost", "放弃这轮");
    drop.addEventListener("click", function () {
      if (!window.confirm("放弃上次没刷完的那一轮？每张卡已经记下的进度不会丢。")) return;
      clearSavedSession();
      render();
    });
    actions.appendChild(go);
    actions.appendChild(drop);
    card.appendChild(actions);
    return card;
  }

  function resumeSession() {
    var s = savedSession;
    if (!s) return;
    var byId = {};
    deck.forEach(function (c) {
      byId[c.id] = c;
    });
    var ids = s.queueIds || [];
    var queue = ids
      .map(function (id) {
        return byId[id];
      })
      .filter(Boolean);
    if (!queue.length) {
      clearSavedSession();
      window.alert("上次那一轮的词已经不在当前词库里了（词库重建过），已清掉这条记录。");
      render();
      return;
    }
    var skipped = ids.length - queue.length;
    var requeue = (s.requeueIds || [])
      .map(function (id) {
        return byId[id];
      })
      .filter(Boolean);
    session = {
      kind: s.kind,
      mode: s.mode,
      startedAt: s.startedAt || s.savedAt,
      queue: queue,
      total: queue.length,
      idx: Math.min(Math.max(0, s.idx || 0), queue.length - 1),
      round: s.round || 1,
      requeue: requeue,
      stats: s.stats || { know: 0, fuzzy: 0, no: 0 },
      revealed: !!s.revealed,
      showCn: !!s.showCn,
      mcqAnswered: s.mcqAnswered || "",
      mcqOptions: s.mcqOptions || [],
      deepStage: s.deepStage || 1,
      deep: s.deep && typeof s.deep === "object" ? s.deep : emptyDeepState(),
    };
    view = "session";
    persistSession();
    if (skipped) window.alert("有 " + skipped + " 张卡已经不在词库里，已跳过。");
    render();
  }

  /* ---------------- 简版学习记录 ---------------- */

  function learningLog() {
    var today = todayStr();
    var byDate = {};
    Object.keys(progress.cards).forEach(function (id) {
      var rec = progress.cards[id];
      if (rec && rec.lastAt) byDate[rec.lastAt] = (byDate[rec.lastAt] || 0) + 1;
    });
    var week = [];
    for (var i = 6; i >= 0; i--) {
      var d = addDays(today, -i);
      week.push({ date: d, count: byDate[d] || 0 });
    }
    var streak = 0;
    var cursor = byDate[today] ? today : addDays(today, -1);
    while (byDate[cursor]) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    var weekTotal = week.reduce(function (sum, d) {
      return sum + d.count;
    }, 0);
    return { today: byDate[today] || 0, streak: streak, week: week, weekTotal: weekTotal };
  }

  function renderLog() {
    var log = learningLog();
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", "学习记录"));
    var grid = el("div", "vstat-grid vstat-grid-3");
    grid.appendChild(statChip("今天动过", log.today));
    grid.appendChild(statChip("连续天数", log.streak));
    grid.appendChild(statChip("近 7 天合计", log.weekTotal));
    card.appendChild(grid);
    var max = 1;
    log.week.forEach(function (d) {
      if (d.count > max) max = d.count;
    });
    var bars = el("div", "vbars");
    log.week.forEach(function (d) {
      var col = el("div", "vbar-col");
      col.appendChild(el("span", "vbar-num", d.count ? String(d.count) : ""));
      var bar = el("div", "vbar");
      bar.style.height = (d.count ? Math.max(6, Math.round((d.count / max) * 48)) : 2) + "px";
      if (!d.count) bar.classList.add("vbar-empty");
      col.appendChild(bar);
      col.appendChild(el("span", "vbar-date", d.date.slice(5)));
      bars.appendChild(col);
    });
    card.appendChild(bars);
    card.appendChild(
      el("p", "note", "口径：当天动过的不同卡片数（同一张卡当天刷两次只算一张；记录只保留每张卡的最后日期）。")
    );
    return card;
  }

  function renderSummary() {
    var s = computeSummary();
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", "今日概览"));
    var grid = el("div", "vstat-grid");
    grid.appendChild(statChip("待复习", s.due));
    grid.appendChild(statChip("没见过的词", s.fresh));
    grid.appendChild(statChip("已掌握", s.mastered));
    grid.appendChild(statChip("库里总卡数", s.total));
    card.appendChild(grid);
    var skillGrid = el("div", "vstat-grid vstat-grid-skill");
    skillGrid.appendChild(statChip("能说词义", s.meaning));
    skillGrid.appendChild(statChip("能看义说词", s.recall));
    skillGrid.appendChild(statChip("能语境使用", s.use));
    skillGrid.appendChild(statChip("完成三步", s.loop));
    card.appendChild(skillGrid);
    var hint = el("p", "note");
    hint.textContent =
      "后四项只统计三步主动训练里的真实表现：能说词义、能看义写词、能在语境里使用。" +
      "「已掌握」仍按原来的 16 / 35 天复扫口径计算。";
    card.appendChild(hint);
    return card;
  }

  function renderStart() {
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", "开始训练"));

    var qRow = el("div", "vrow");
    qRow.appendChild(el("span", "vrow-label", "刷什么"));
    [
      ["daily", "今天的一轮"],
      ["due", "只刷到期"],
      ["new", "只刷新词"],
      ["wrong", "只刷错词"],
      ["today", "今日复习"],
    ].forEach(function (pair) {
      var b = el("button", "btn btn-ghost vpick", pair[1]);
      b.dataset.queue = pair[0];
      b.classList.toggle("active", filters.queue === pair[0]);
      b.addEventListener("click", function () {
        filters.queue = pair[0];
        render();
      });
      qRow.appendChild(b);
    });
    card.appendChild(qRow);

    var mRow = el("div", "vrow");
    mRow.appendChild(el("span", "vrow-label", "怎么刷"));
    [
      ["deep", "三步主动训练"],
      ["self", "翻面自评"],
      ["mcq", "选择题"],
    ].forEach(function (pair) {
      var b = el("button", "btn btn-ghost vpick", pair[1]);
      b.classList.toggle("active", progress.settings.mode === pair[0]);
      b.addEventListener("click", function () {
        progress.settings.mode = pair[0];
        saveProgress();
        render();
      });
      mRow.appendChild(b);
    });
    card.appendChild(mRow);
    var startRow = el("div", "vrow");
    startRow.appendChild(el("span", "vrow-label", "本轮上限"));
    if (progress.settings.mode === "deep") startRow.appendChild(limitInput("主动训练", "deepLimit"));
    else {
      startRow.appendChild(limitInput("新词", "newLimit"));
      startRow.appendChild(limitInput("复习", "reviewLimit"));
    }
    card.appendChild(startRow);

    var actions = el("div", "actions");
    var startBtn = el("button", "btn btn-primary", "开始");
    startBtn.addEventListener("click", function () {
      if (savedSession) {
        var left = Math.max(0, (savedSession.queueIds || []).length - (savedSession.idx || 0));
        if (!window.confirm("上一轮还剩 " + left + " 张没刷完，开始新的一轮会放弃它。继续吗？")) return;
        clearSavedSession();
      }
      ensureDictionary()
        .then(function () {
          startSession(filters.queue, progress.settings.mode);
        })
        .catch(function () {
          /* ensureDictionary 已提示 */
        });
    });
    if (!previewCount()) {
      startBtn.disabled = true;
      startBtn.textContent = deck.length ? "没有可练词条" : "先添加生词";
    }
    actions.appendChild(startBtn);
    var s = computeSummary();
    var previewText =
      "本次将按「" + queueLabel(filters.queue) + " · " +
      modeLabel(progress.settings.mode) + "」出 " + previewCount() + " 张";
    previewText +=
      filters.queue === "today"
        ? "（今天刷过的再来一遍，顺序和今天一致）"
        : "（待复习 " + s.due + " / 新词 " + s.fresh + "）";
    actions.appendChild(el("span", "note", previewText));
    card.appendChild(actions);
    return card;
  }

  function limitInput(label, key) {
    var wrap = el("label", "vnum");
    wrap.appendChild(el("span", null, label));
    var input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "200";
    input.value = String(progress.settings[key]);
    input.addEventListener("change", function () {
      var v = parseInt(input.value, 10);
      if (!isFinite(v) || v < 1) v = DEFAULT_SETTINGS[key];
      progress.settings[key] = v;
      saveProgress();
      render();
    });
    wrap.appendChild(input);
    return wrap;
  }

  function queueLabel(kind) {
    return kind === "due"
      ? "只刷到期"
      : kind === "new"
      ? "只刷新词"
      : kind === "wrong"
      ? "只刷错词"
      : kind === "today"
      ? "今日复习"
      : "今天的一轮";
  }

  function previewCount() {
    return makeQueue(filters.queue, progress.settings.mode).length;
  }

  function renderManage() {
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", "进度管理"));
    var line = el("p", "note");
    line.textContent = "已记录 " + Object.keys(progress.cards).length + " 张卡的复习进度";
    card.appendChild(line);
    var actions = el("div", "actions");
    var exp = el("button", "btn btn-ghost", "导出全部数据");
    exp.addEventListener("click", exportProgress);
    var imp = el("button", "btn btn-ghost", "导入全部数据");
    var file = document.createElement("input");
    file.type = "file";
    file.accept = "application/json,.json";
    file.hidden = true;
    file.addEventListener("change", function () {
      if (file.files && file.files[0]) importProgress(file.files[0]);
      file.value = "";
    });
    imp.addEventListener("click", function () {
      file.click();
    });
    var reset = el("button", "btn btn-ghost", "清空进度");
    reset.addEventListener("click", function () {
      if (!window.confirm("确定清空全部复习进度？导出备份后可以再导回来。")) return;
      progress.cards = {};
      saveProgress();
      render();
    });
    actions.appendChild(exp);
    actions.appendChild(imp);
    actions.appendChild(reset);
    actions.appendChild(file);
    card.appendChild(actions);
    return card;
  }

  function renderSessionHead() {
    var card = el("section", "card vhead");
    var left = el("span", "vhead-left");
    left.textContent =
      (session.round === 1 ? "第 " + (session.idx + 1) + " / " + session.queue.length + " 张" : "错词重考 " + (session.idx + 1) + " / " + session.queue.length) +
      " · " + queueLabel(session.kind) + " · " + modeLabel(session.mode) +
      (session.mode === "deep" ? " · " + DEEP_STAGE_LABEL[(session.deepStage || 1) - 1] : "");
    var right = el("span", "vhead-right");
    right.textContent = "认识 " + session.stats.know + " · 模糊 " + session.stats.fuzzy + " · 不认识 " + session.stats.no;
    var quit = el("button", "btn btn-ghost vquit", "结束");
    quit.addEventListener("click", function () {
      persistSession(); // 「结束」＝保存并退出，下次可以从概览接着刷
      view = "done";
      render();
    });
    card.appendChild(left);
    card.appendChild(right);
    card.appendChild(quit);
    return card;
  }

  function metaLine(card) {
    var bits = [];
    bits.push(card.bucket === "custom" ? BOOK_TYPE_LABEL[card.type] || "生词本" : BUCKET_LABEL[card.bucket] || card.bucket);
    if (card.pos && !(card.type === "phrase" && card.pos === "phrase")) bits.push(card.pos);
    if (card.date) bits.push(card.date);
    return bits.join(" · ");
  }

  function speakButton(card) {
    if (!ttsOk) return null;
    var b = el("button", "btn btn-ghost vspeak", "🔊 读一遍");
    b.addEventListener("click", function () {
      speak(card.term);
    });
    return b;
  }

  function renderCardBox() {
    var card = currentCard();
    var box = el("section", "card vcard");
    if (!card) {
      box.appendChild(el("p", "note", "这一轮结束了。"));
      return box;
    }
    box.appendChild(el("p", "vmeta", metaLine(card)));
    var hideTerm = session.mode === "deep" && (session.deepStage || 1) > 1;
    if (!hideTerm) {
      var term = el("p", "vterm", card.term);
      box.appendChild(term);
      if (card.ipa) box.appendChild(el("p", "vipa", "/" + card.ipa + "/"));
      var spk = speakButton(card);
      if (spk) box.appendChild(spk);
    }
    if (session.mode === "deep") renderDeep(box, card);
    else if (session.mode === "mcq") renderMcq(box, card);
    else renderSelf(box, card);
    return box;
  }

  function dictionaryDetails(card) {
    var box = el("div", "vdict");
    if (card.pos) box.appendChild(el("p", "vpos", card.pos));
    if (card.en) box.appendChild(el("p", "ven", card.en));
    if (card.cn) box.appendChild(el("p", "vcn", card.cn));
    if (card.example) {
      var ex = el("p", "vex");
      ex.appendChild(el("span", "vex-tag", "语境"));
      ex.appendChild(document.createTextNode(card.example));
      box.appendChild(ex);
    }
    if (card.exchange) box.appendChild(el("p", "vnote-small", "词形变化：" + card.exchange));
    if (!card.cn && !card.en) box.appendChild(el("p", "vnote-small", "词典暂未收录，请换个拼写或短语后再试。"));
    return box;
  }

  function deepStageBar(box) {
    var bar = el("div", "vdeep-bar");
    [1, 2, 3].forEach(function (num) {
      var item = el("div", "vdeep-step" + (num <= session.deepStage ? " active" : ""));
      item.appendChild(el("span", "vdeep-step-num", String(num)));
      item.appendChild(el("span", null, DEEP_STAGE_LABEL[num - 1]));
      bar.appendChild(item);
    });
    box.appendChild(bar);
  }

  function renderDeep(box, card) {
    deepStageBar(box);
    if (session.deepStage === 1) {
      box.appendChild(el("p", "vdeep-prompt", "先不要看释义：大声读这个词，并用自己的话说出它的大意和词性。"));
      box.appendChild(el("p", "vnote-small", "这里只测“无提示回忆”。说不清就如实选择，不会影响后面继续练。"));
      var actions = el("div", "actions vactions");
      [
        ["no", "完全没想起", "btn-no"],
        ["fuzzy", "想起一点", "btn-fuzzy"],
        ["know", "说清楚了", "btn-know"],
      ].forEach(function (pair) {
        var button = el("button", "btn " + pair[2], pair[1]);
        button.addEventListener("click", function () {
          session.deep.meaning = pair[0];
          session.deepStage = 2;
          persistSession();
          render();
        });
        actions.appendChild(button);
      });
      box.appendChild(actions);
      return;
    }

    if (session.deepStage === 2) {
      box.appendChild(el("p", "vdeep-prompt", "中文线索"));
      box.appendChild(el("p", "vclue", card.cn || "（无中文线索，利用下面的英文解释反推）"));
      var hint = el("div", "vhint");
      var hintBtn = el("button", "btn btn-ghost vsmall-btn", "需要时看英文释义");
      var hintBody = dictionaryDetails(card);
      hintBody.hidden = true;
      hintBtn.addEventListener("click", function () {
        hintBody.hidden = !hintBody.hidden;
        hintBtn.textContent = hintBody.hidden ? "需要时看英文释义" : "收起英文释义";
      });
      hint.appendChild(hintBtn);
      hint.appendChild(hintBody);
      box.appendChild(hint);
      var answerWrap = el("div", "vdeep-answer");
      var input = document.createElement("input");
      input.className = "vselect vdeep-input";
      input.type = "text";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "输入对应的英文单词或短语";
      input.value = session.deep.recallAnswer || "";
      input.addEventListener("input", function () {
        session.deep.recallAnswer = input.value;
      });
      answerWrap.appendChild(input);
      box.appendChild(answerWrap);

      if (session.deep.recallChecked) {
        var correct = !!session.deep.recallCorrect;
        box.appendChild(
          el(
            "p",
            "vverdict " + (correct ? "right-text" : "wrong-text"),
            correct ? "正确：你从中文线索里取回了英文。" : "目标表达是：" + card.term
          )
        );
        if (!correct && card.example) box.appendChild(el("p", "vnote-small", "语境：" + card.example));
        var next = el("button", "btn btn-primary", "继续：放回语境");
        next.addEventListener("click", function () {
          session.deepStage = 3;
          persistSession();
          render();
        });
        box.appendChild(next);
        return;
      }

      var actions = el("div", "actions vactions");
      var check = el("button", "btn btn-primary", "核对");
      check.addEventListener("click", function () {
        session.deep.recallAnswer = input.value;
        session.deep.recallCorrect = answersMatch(card, input.value);
        session.deep.recallChecked = true;
        persistSession();
        render();
      });
      var stuck = el("button", "btn btn-ghost", "卡住了，看答案");
      stuck.addEventListener("click", function () {
        session.deep.recallAnswer = input.value;
        session.deep.recallCorrect = false;
        session.deep.recallChecked = true;
        persistSession();
        render();
      });
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") check.click();
      });
      actions.appendChild(check);
      actions.appendChild(stuck);
      box.appendChild(actions);
      return;
    }

    var cloze = makeCloze(card);
    box.appendChild(
      el(
        "p",
        "vdeep-prompt",
        cloze ? "补全下面的原文语境：" : "用目标表达写一句完整的英文，放进你自己的生活场景："
      )
    );
    if (cloze) {
      box.appendChild(el("p", "vcloze", cloze.sentence));
    } else {
      box.appendChild(el("p", "vclue", "目标：" + card.term));
      if (card.cn) box.appendChild(el("p", "vnote-small", "想表达：" + card.cn.split("\n")[0]));
    }
    var textarea = document.createElement("textarea");
    textarea.className = "vselect vdeep-textarea";
    textarea.rows = cloze ? 2 : 4;
    textarea.placeholder = cloze ? "填入缺失的表达" : "不要求高级词，先把意思写完整";
    textarea.value = session.deep.useAnswer || "";
    textarea.addEventListener("input", function () {
      session.deep.useAnswer = textarea.value;
    });
    box.appendChild(textarea);

    if (session.deep.useChecked) {
      var used = !!session.deep.useCorrect;
      box.appendChild(
        el(
          "p",
          "vverdict " + (used ? "right-text" : "wrong-text"),
          used ? "目标表达已经出现，句子也完成了这次主动产出。" : "没有检测到目标表达，再对照下面的模型后重写一次。"
        )
      );
      if (card.example) box.appendChild(el("p", "vnote-small", "原文语境：" + card.example));
      box.appendChild(dictionaryDetails(card));
      box.appendChild(el("p", "vnote-small", "现在按整张卡的真实表现选择复习间隔："));
      var finish = el("div", "actions vactions");
      [
        ["know", "会用了", "btn-know"],
        ["fuzzy", "想得起，但会出错", "btn-fuzzy"],
        ["no", "还没掌握", "btn-no"],
      ].forEach(function (pair) {
        var button = el("button", "btn " + pair[2], pair[1]);
        button.addEventListener("click", function () {
          rate(pair[0]);
        });
        finish.appendChild(button);
      });
      box.appendChild(finish);
      return;
    }

    var actions = el("div", "actions vactions");
    var check = el("button", "btn btn-primary", "检查这一步");
    check.addEventListener("click", function () {
      session.deep.useAnswer = textarea.value;
      session.deep.useCorrect = cloze
        ? answersMatch(card, textarea.value, cloze.answer)
        : answerUsesExpression(card, textarea.value);
      session.deep.useChecked = true;
      persistSession();
      render();
    });
    var reveal = el("button", "btn btn-ghost", "先看答案再写");
    reveal.addEventListener("click", function () {
      session.deep.useAnswer = textarea.value;
      session.deep.useCorrect = false;
      session.deep.useChecked = true;
      persistSession();
      render();
    });
    actions.appendChild(check);
    actions.appendChild(reveal);
    box.appendChild(actions);
  }

  function renderSelf(box, card) {
    var answer = el("div", "vanswer");
    answer.hidden = !session.revealed;
    if (session.revealed) {
      if (card.pos) answer.appendChild(el("p", "vpos", card.pos));
      if (card.en) answer.appendChild(el("p", "ven", card.en));
      if (card.example) {
        var ex = el("p", "vex");
        ex.appendChild(el("span", "vex-tag", "例句"));
        ex.appendChild(document.createTextNode(card.example));
        answer.appendChild(ex);
      }
      var cnBox = el("p", "vcn");
      cnBox.hidden = !session.showCn;
      cnBox.textContent = card.cn || "（这条没有中文释义）";
      answer.appendChild(cnBox);
    }
    box.appendChild(answer);

    var actions = el("div", "actions vactions");
    if (!session.revealed) {
      var showBtn = el("button", "btn btn-primary", "显示答案（空格）");
      showBtn.addEventListener("click", function () {
        session.revealed = true;
        persistSession();
        render();
      });
      actions.appendChild(showBtn);
    } else {
      if (card.cn) {
        var cnBtn = el("button", "btn btn-ghost", session.showCn ? "收起中文（空格）" : "看中文（空格）");
        cnBtn.addEventListener("click", function () {
          session.showCn = !session.showCn;
          persistSession();
          render();
        });
        actions.appendChild(cnBtn);
      }
      [
        ["know", "认识（1）", "btn-know"],
        ["fuzzy", "模糊（2）", "btn-fuzzy"],
        ["no", "不认识（3）", "btn-no"],
      ].forEach(function (pair) {
        var b = el("button", "btn " + pair[2], pair[1]);
        b.addEventListener("click", function () {
          rate(pair[0]);
        });
        actions.appendChild(b);
      });
    }
    box.appendChild(actions);
  }

  function buildMcqOptions(card) {
    var correct = card.en;
    var samePos = [];
    var sameBoth = [];
    var rest = [];
    deck.forEach(function (c) {
      if (c.id === card.id || !c.en || c.en === correct) return;
      if (c.pos && c.pos === card.pos) {
        samePos.push(c.en);
        if (c.bucket === card.bucket) sameBoth.push(c.en);
      } else {
        rest.push(c.en);
      }
    });
    var picks = [];
    var used = {};
    used[correct] = true;
    var pools = [shuffle(sameBoth), shuffle(samePos), shuffle(rest)];
    for (var i = 0; i < pools.length && picks.length < 3; i++) {
      for (var j = 0; j < pools[i].length && picks.length < 3; j++) {
        if (used[pools[i][j]]) continue;
        used[pools[i][j]] = true;
        picks.push(pools[i][j]);
      }
    }
    return shuffle(picks.concat([correct]));
  }

  function renderMcq(box, card) {
    if (!session.mcqOptions.length) session.mcqOptions = buildMcqOptions(card);
    var list = el("div", "voptions");
    session.mcqOptions.forEach(function (opt, i) {
      var b = el("button", "voption", (i + 1) + ". " + opt);
      var isCorrect = opt === card.en;
      if (session.mcqAnswered && isCorrect) b.classList.add("right");
      if (session.mcqAnswered && session.mcqAnswered !== "right" && !isCorrect) b.classList.add("dim");
      if (session.mcqAnswered) b.disabled = true;
      b.addEventListener("click", function () {
        if (session.mcqAnswered) return;
        session.mcqAnswered = isCorrect ? "right" : "wrong";
        session.stats[isCorrect ? "know" : "no"] += 1;
        applyRating(card, isCorrect ? "know" : "no");
        if (!isCorrect) session.requeue.push(card);
        persistSession();
        render();
      });
      list.appendChild(b);
    });
    box.appendChild(list);

    if (session.mcqAnswered) {
      var verdict = el("p", "vverdict", "");
      verdict.textContent = session.mcqAnswered === "right" ? "答对了。" : "答错了。正确释义：" + card.en;
      box.appendChild(verdict);
      var actions = el("div", "actions vactions");
      var next = el("button", "btn btn-primary", "下一张（回车）");
      next.addEventListener("click", advance);
      actions.appendChild(next);
      box.appendChild(actions);
    } else {
      box.appendChild(el("p", "note", "选出与这个词最接近的英文释义；全程不出现中文。"));
    }
  }

  function renderDone() {
    var leftover = savedSession
      ? Math.max(0, (savedSession.queueIds || []).length - (savedSession.idx || 0))
      : 0;
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", leftover ? "这一轮先到这里" : "这一轮结束了"));
    var grid = el("div", "vstat-grid");
    grid.appendChild(statChip("认识", session.stats.know));
    grid.appendChild(statChip("模糊", session.stats.fuzzy));
    grid.appendChild(statChip("不认识", session.stats.no));
    card.appendChild(grid);
    if (leftover) {
      card.appendChild(
        el("p", "vresume-line", "还剩 " + leftover + " 张没刷完，已经存下来了——回到概览点「继续」就能接着刷。")
      );
    }
    var actions = el("div", "actions");
    var again = el("button", "btn btn-ghost", "再刷一轮");
    again.addEventListener("click", function () {
      if (savedSession) {
        if (!window.confirm("上一轮还剩 " + leftover + " 张没刷完，开始新的一轮会放弃它。继续吗？")) return;
        clearSavedSession();
      }
      startSession(session.kind, session.mode);
    });
    var back = el("button", "btn btn-primary", "回到概览");
    back.addEventListener("click", function () {
      view = "overview";
      render();
    });
    actions.appendChild(again);
    actions.appendChild(back);
    card.appendChild(actions);
    var s = computeSummary();
    card.appendChild(
      el("p", "note", "当前待复习 " + s.due + " 张，没见过的 " + s.fresh + " 张，已掌握 " + s.mastered + " 张。")
    );
    return card;
  }

  /* ---------------- 导入导出 ---------------- */

  function exportProgress() {
    var payload = {
      version: 2,
      updatedAt: progress.updatedAt,
      cards: progress.cards,
      settings: progress.settings,
      today: progress.today || null,
      session: savedSession || null,
      library: library,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "english-practice-data-" + todayStr().replace(/-/g, "") + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function mergeProgress(incoming) {
    var merged = 0;
    var cards = (incoming && incoming.cards) || {};
    Object.keys(cards).forEach(function (id) {
      var b = cards[id];
      if (!b || typeof b !== "object") return;
      var a = progress.cards[id];
      if (!a) {
        progress.cards[id] = b;
        merged += 1;
        return;
      }
      var aLast = a.lastAt || "";
      var bLast = b.lastAt || "";
      a.box = Math.max(a.box || 0, b.box || 0);
      a.seen = Math.max(a.seen || 0, b.seen || 0);
      a.know = Math.max(a.know || 0, b.know || 0);
      a.fuzzy = Math.max(a.fuzzy || 0, b.fuzzy || 0);
      a.no = Math.max(a.no || 0, b.no || 0);
      a.lastAt = aLast > bLast ? aLast : bLast;
      a.due = aLast >= bLast ? a.due : b.due;
      if (bLast > aLast && b.skills) a.skills = b.skills;
      progress.cards[id] = a;
      merged += 1;
    });
    return merged;
  }

  function mergeLibrary(incoming) {
    if (!incoming || !Array.isArray(incoming.books)) return 0;
    var mergedBooks = 0;
    incoming.books.forEach(function (source) {
      if (!source || !source.id || !source.name || !Array.isArray(source.entries)) return;
      var target = findBook(source.id);
      if (!target) {
        library.books.push(source);
        mergedBooks += 1;
        return;
      }
      var byTerm = {};
      target.entries.forEach(function (entry) {
        byTerm[String(entry.term || "").toLowerCase()] = true;
      });
      source.entries.forEach(function (entry) {
        var key = String(entry.term || "").toLowerCase();
        if (key && !byTerm[key]) {
          target.entries.push(entry);
          byTerm[key] = true;
        }
      });
      mergedBooks += 1;
    });
    if (incoming.activeBookId && findBook(incoming.activeBookId)) {
      library.activeBookId = incoming.activeBookId;
    }
    saveLibrary();
    return mergedBooks;
  }

  function importProgress(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (err) {
        window.alert("这个文件不是有效的 JSON，进度没有改动。");
        return;
      }
      if (!data || typeof data !== "object" || (!data.cards && !data.library)) {
        window.alert("文件里没有生词本或进度数据，未导入。");
        return;
      }
      var n = data.cards && typeof data.cards === "object" ? mergeProgress(data) : 0;
      var b = mergeLibrary(data.library);
      if (data.today && data.today.date === todayStr() && Array.isArray(data.today.ids)) {
        var mergedToday = todayQueueIds();
        data.today.ids.forEach(function (id) {
          if (mergedToday.indexOf(id) === -1) mergedToday.push(id);
        });
        progress.today = { date: todayStr(), ids: mergedToday };
      }
      saveProgress();
      var note =
        "已合并 " + b + " 本生词本、 " + n + " 张卡的进度（同一张卡取课时更高、时间更晚的一次）。";
      if (data.session && data.session.queueIds && data.session.queueIds.length) {
        if (!savedSession) {
          writeSession(data.session);
          note +=
            "\n另外恢复了文件里那轮没刷完的复习：" + sessionPosLabel(data.session) + "，回到概览点「继续」即可接着刷。";
        } else {
          note += "\n文件里也有一轮没刷完的复习，但本机已经有了，保留了本机那一条。";
        }
      }
      render();
      window.alert(note);
    };
    reader.onerror = function () {
      window.alert("读文件失败，进度没有改动。");
    };
    reader.readAsText(file);
  }

  /* ---------------- 键盘 ---------------- */

  document.addEventListener("keydown", function (e) {
    if (view !== "session" || !session) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    var key = e.key;
    if (session.mode === "deep") {
      if (key === "Enter") {
        var primary = root.querySelector(".vcard .btn-primary");
        if (primary && !primary.disabled) {
          e.preventDefault();
          primary.click();
        }
      }
      return;
    }
    if (session.mode === "mcq") {
      if (session.mcqAnswered) {
        if (key === "Enter" || key === " ") {
          e.preventDefault();
          advance();
        }
        return;
      }
      var n = parseInt(key, 10);
      if (n >= 1 && n <= 4) {
        var btns = root.querySelectorAll(".voption");
        if (btns[n - 1]) btns[n - 1].click();
      }
      return;
    }
    if (!session.revealed) {
      if (key === " " || key === "Enter") {
        e.preventDefault();
        session.revealed = true;
        persistSession();
        render();
      }
      return;
    }
    if (key === " ") {
      var cur = currentCard();
      if (cur && cur.cn) {
        e.preventDefault();
        session.showCn = !session.showCn;
        persistSession();
        render();
      }
      return;
    }
    if (key === "1") {
      rate("know");
    } else if (key === "2") {
      rate("fuzzy");
    } else if (key === "3") {
      rate("no");
    }
  });

  /* ---------------- 启动 ---------------- */

  async function boot() {
    root = qs("#vocab");
    if (!root) return;
    progress = loadProgress();
    library = loadLibrary();
    savedSession = readSession();
    try {
      var res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("数据加载失败：" + res.status);
      var data = await res.json();
      builtinCards = Array.isArray(data) ? data : data.cards || [];
    } catch (err) {
      builtinCards = [];
    }
    builtinById = {};
    builtinCards.forEach(function (card) {
      builtinById[card.id] = card;
    });
    refreshDeck();
    if (deck.length) {
      root.innerHTML = '<div class="empty-tip">正在加载内置词典…</div>';
      try {
        await ensureDictionary();
        refreshDeck();
      } catch (err) {
        root.innerHTML = '<div class="empty-tip">内置词典加载失败：' + err.message + "</div>";
        return;
      }
    }
    render();
  }

  boot();
})();
