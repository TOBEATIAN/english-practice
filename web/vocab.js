(function () {
  "use strict";

  var DATA_URL = "vocab.json";
  var PROGRESS_KEY = "shadow-vocab-v1";
  var SESSION_KEY = "shadow-vocab-session-v1";
  var INTERVALS = [1, 3, 7, 16, 35]; // 盒 1..5 对应的天数
  var BOX_LABEL = ["未学", "第 1 盒", "第 2 盒", "第 3 盒", "第 4 盒", "第 5 盒"];
  var BUCKET_LABEL = {
    wrong: "复盘错词",
    keyphrase: "必背与句式",
    bank: "复盘词库",
    shadow: "影子跟读",
  };
  var DEFAULT_SETTINGS = { newLimit: 20, reviewLimit: 40, mode: "self" };

  var deck = [];
  var progress = null;
  var root = null;
  var view = "overview";
  var session = null;
  var savedSession = null;
  var filters = { date: "", source: "", queue: "daily" };
  var ttsOk = typeof window !== "undefined" && "speechSynthesis" in window;

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

  function cardState(c) {
    var rec = progress.cards[c.id];
    if (!rec) return "new";
    if (rec.due && rec.due <= todayStr()) return "due";
    return "later";
  }

  function makeQueue(kind, mode) {
    var pool = filteredCards();
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
    else queue = due.slice(0, progress.settings.reviewLimit).concat(fresh.slice(0, progress.settings.newLimit));
    if (mode === "mcq") {
      queue = queue.filter(function (c) {
        return !!c.en;
      });
    }
    return queue;
  }

  function computeSummary() {
    var pool = filteredCards();
    var s = { total: pool.length, due: 0, fresh: 0, mastered: 0, learning: 0 };
    pool.forEach(function (c) {
      var st = cardState(c);
      if (st === "new") s.fresh += 1;
      if (st === "due") s.due += 1;
      var rec = progress.cards[c.id];
      if (rec && (rec.box || 0) >= 4) s.mastered += 1;
      else if (rec) s.learning += 1;
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
    root.appendChild(renderSummary());
    if (savedSession) root.appendChild(renderResume());
    root.appendChild(renderStart());
    root.appendChild(renderLog());
    root.appendChild(renderManage());
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
        sessionPosLabel(s) + " · " + queueLabel(s.kind) + " · " + (s.mode === "mcq" ? "选择题" : "翻面自评") +
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
    var hint = el("p", "note");
    hint.textContent =
      "「已掌握」＝已经过 16 天和 35 天两档复扫的卡（第 4 盒及以上）。进度存在本机浏览器，" +
      "换设备请用下面的导出 / 导入。";
    card.appendChild(hint);
    return card;
  }

  function renderStart() {
    var card = el("section", "card");
    card.appendChild(el("h2", "section-title", "开始复习"));

    var qRow = el("div", "vrow");
    qRow.appendChild(el("span", "vrow-label", "刷什么"));
    [
      ["daily", "今天的一轮"],
      ["due", "只刷到期"],
      ["new", "只刷新词"],
      ["wrong", "只刷错词"],
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

    var fRow = el("div", "vrow");
    fRow.appendChild(el("span", "vrow-label", "范围"));
    var srcSel = el("select", "vselect");
    [
      ["", "全部来源"],
      ["review", "只看复盘生词"],
      ["shadow", "只看影子跟读"],
    ].forEach(function (pair) {
      var o = el("option", null, pair[1]);
      o.value = pair[0];
      srcSel.appendChild(o);
    });
    srcSel.value = filters.source;
    srcSel.addEventListener("change", function () {
      filters.source = srcSel.value;
      render();
    });
    fRow.appendChild(srcSel);

    var dates = {};
    deck.forEach(function (c) {
      dates[c.date] = true;
    });
    var dateSel = el("select", "vselect");
    var allOpt = el("option", null, "全部日期");
    allOpt.value = "";
    dateSel.appendChild(allOpt);
    Object.keys(dates)
      .sort()
      .reverse()
      .forEach(function (d) {
        var o = el("option", null, d);
        o.value = d;
        dateSel.appendChild(o);
      });
    dateSel.value = filters.date;
    dateSel.addEventListener("change", function () {
      filters.date = dateSel.value;
      render();
    });
    fRow.appendChild(dateSel);
    card.appendChild(fRow);

    var sRow = el("div", "vrow");
    sRow.appendChild(el("span", "vrow-label", "本轮上限"));
    sRow.appendChild(limitInput("新词", "newLimit"));
    sRow.appendChild(limitInput("复习", "reviewLimit"));
    card.appendChild(sRow);

    var actions = el("div", "actions");
    var startBtn = el("button", "btn btn-primary", "开始");
    startBtn.addEventListener("click", function () {
      if (savedSession) {
        var left = Math.max(0, (savedSession.queueIds || []).length - (savedSession.idx || 0));
        if (!window.confirm("上一轮还剩 " + left + " 张没刷完，开始新的一轮会放弃它。继续吗？")) return;
        clearSavedSession();
      }
      startSession(filters.queue, progress.settings.mode);
    });
    actions.appendChild(startBtn);
    var s = computeSummary();
    actions.appendChild(
      el(
        "span",
        "note",
        "本次将按「" + queueLabel(filters.queue) + " · " + (progress.settings.mode === "mcq" ? "选择题" : "翻面自评") +
          "」出 " + previewCount() + " 张（待复习 " + s.due + " / 新词 " + s.fresh + "）"
      )
    );
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
    return kind === "due" ? "只刷到期" : kind === "new" ? "只刷新词" : kind === "wrong" ? "只刷错词" : "今天的一轮";
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
    var exp = el("button", "btn btn-ghost", "导出进度");
    exp.addEventListener("click", exportProgress);
    var imp = el("button", "btn btn-ghost", "导入进度");
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
      " · " + queueLabel(session.kind) + " · " + (session.mode === "mcq" ? "选择题" : "翻面自评");
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
    bits.push(BUCKET_LABEL[card.bucket] || card.bucket);
    if (card.pos) bits.push(card.pos);
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
    var term = el("p", "vterm", card.term);
    box.appendChild(term);
    var spk = speakButton(card);
    if (spk) box.appendChild(spk);
    if (session.mode === "mcq") renderMcq(box, card);
    else renderSelf(box, card);
    return box;
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
        var cnBtn = el("button", "btn btn-ghost", session.showCn ? "收起中文" : "看中文");
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
      updatedAt: progress.updatedAt,
      cards: progress.cards,
      settings: progress.settings,
      session: savedSession || null,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "english-practice-vocab-" + todayStr().replace(/-/g, "") + ".json";
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
      progress.cards[id] = a;
      merged += 1;
    });
    return merged;
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
      if (!data || typeof data !== "object" || !data.cards || typeof data.cards !== "object") {
        window.alert("文件里没有 cards 字段，进度没有改动。");
        return;
      }
      var n = mergeProgress(data);
      saveProgress();
      var note = "已合并 " + n + " 张卡的进度（同一张卡取课时更高、时间更晚的一次）。";
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
    savedSession = readSession();
    try {
      var res = await fetch(DATA_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error("数据加载失败：" + res.status);
      var data = await res.json();
      deck = Array.isArray(data) ? data : data.cards || [];
      if (!deck.length) throw new Error("词库是空的");
    } catch (err) {
      root.innerHTML = '<div class="empty-tip">词库加载失败：' + err.message + "</div>";
      return;
    }
    render();
  }

  boot();
})();
