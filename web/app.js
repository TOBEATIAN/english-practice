(function () {
  "use strict";

  var DATA_URL = "materials.json";
  var GROUP_SIZE = 10;
  var PRACTICE_KEY = "shadow-practiced-v1";
  var SPEED_KEY = "shadow-speed-v1";
  var DICTATION_KEY = "shadow-dictation-v1";
  var MODE_KEY = "shadow-mode-v1";
  var ERROR_TAGS = ["连读弱读", "生词", "语法词形", "注意力断线"];

  var player = new Audio();
  var playerBar = null;
  var pbPlay = null;
  var pbLabel = null;
  var pbRange = null;
  var pbTime = null;
  var pbSpeed = null;
  var pbLoop = null;
  var activeBtn = null;
  var currentSpeed = 1;
  var loopOn = false;

  function qs(sel) {
    return document.querySelector(sel);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function setBtnIcon(btn, playing) {
    if (!btn) return;
    btn.dataset.playing = playing ? "1" : "0";
    var icon = btn.querySelector(".icon");
    if (icon) icon.textContent = playing ? "❚❚" : "▶";
  }

  function clearActive() {
    if (activeBtn) {
      setBtnIcon(activeBtn, false);
      activeBtn.classList.remove("playing");
      activeBtn = null;
    }
  }

  /* ---------------- 播放器（进度条可点击/拖动） ---------------- */

  function ensurePlayerBar() {
    if (playerBar) return;
    playerBar = document.createElement("div");
    playerBar.className = "player-bar";
    pbPlay = document.createElement("button");
    pbPlay.className = "pb-btn pb-play";
    pbPlay.textContent = "▶";
    pbPlay.title = "播放 / 暂停";
    pbLabel = document.createElement("span");
    pbLabel.className = "pb-label";
    pbLabel.textContent = "未播放";
    pbRange = document.createElement("input");
    pbRange.type = "range";
    pbRange.className = "pb-range";
    pbRange.min = "0";
    pbRange.max = "1000";
    pbRange.value = "0";
    pbRange.step = "1";
    pbRange.setAttribute("aria-label", "播放进度");
    pbTime = document.createElement("span");
    pbTime.className = "pb-time";
    pbTime.textContent = "0:00 / 0:00";
    pbSpeed = document.createElement("select");
    pbSpeed.className = "pb-speed";
    [["0.75", "0.75×"], ["1", "1.0×"], ["1.25", "1.25×"]].forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o[0];
      opt.textContent = o[1];
      pbSpeed.appendChild(opt);
    });
    pbLoop = document.createElement("button");
    pbLoop.className = "pb-btn pb-loop";
    pbLoop.textContent = "🔁";
    pbLoop.title = "循环播放当前内容";

    playerBar.appendChild(pbPlay);
    playerBar.appendChild(pbLabel);
    playerBar.appendChild(pbRange);
    playerBar.appendChild(pbTime);
    playerBar.appendChild(pbSpeed);
    playerBar.appendChild(pbLoop);
    document.body.appendChild(playerBar);

    pbPlay.addEventListener("click", function () {
      if (!player.src) return;
      if (player.paused) {
        player.play();
      } else {
        player.pause();
      }
    });
    pbRange.addEventListener("input", function () {
      var ratio = parseFloat(pbRange.value) / 1000;
      forceDuration(function () {
        if (!isFinite(player.duration) || player.duration <= 0) return;
        player.currentTime = ratio * player.duration;
        updateProgressUI();
      });
    });
    pbSpeed.addEventListener("change", function () {
      saveSpeed(parseFloat(pbSpeed.value));
    });
    pbLoop.addEventListener("click", function () {
      loopOn = !loopOn;
      player.loop = loopOn;
      pbLoop.classList.toggle("active", loopOn);
    });

    player.addEventListener("timeupdate", updateProgressUI);
    player.addEventListener("loadedmetadata", function () {
      pbTime.textContent = fmtTime(player.currentTime) + " / " + fmtTime(player.duration);
    });
    player.addEventListener("play", function () {
      pbPlay.textContent = "❚❚";
      playerBar.classList.add("visible");
    });
    player.addEventListener("pause", function () {
      pbPlay.textContent = "▶";
    });
    player.addEventListener("ended", function () {
      pbPlay.textContent = "▶";
      clearActive();
    });
  }

  function updateProgressUI() {
    if (!pbRange) return;
    var d = player.duration;
    if (isFinite(d) && d > 0) {
      pbRange.value = String(Math.round((player.currentTime / d) * 1000));
      pbTime.textContent = fmtTime(player.currentTime) + " / " + fmtTime(d);
    } else {
      pbTime.textContent = fmtTime(player.currentTime) + " / --:--";
    }
  }

  /* 部分静态服务器不支持 Range 请求，浏览器会拿不到总时长；
     这里先触发一次完整读取，拿到真实时长后再执行回调（线上 Pages 不受影响）。 */
  function forceDuration(cb) {
    if (isFinite(player.duration) && player.duration > 0) {
      cb();
      return;
    }
    var done = false;
    function onDur() {
      if (!done && isFinite(player.duration) && player.duration > 0) {
        done = true;
        player.removeEventListener("durationchange", onDur);
        try { player.currentTime = 0; } catch (err) { /* 忽略 */ }
        updateProgressUI();
        cb();
      }
    }
    player.addEventListener("durationchange", onDur);
    try {
      player.currentTime = 1e7;
    } catch (err) {
      cb();
    }
    setTimeout(function () {
      if (!done) {
        done = true;
        player.removeEventListener("durationchange", onDur);
        cb();
      }
    }, 3000);
  }

  function playItem(src, label, btn) {
    if (!src) return;
    ensurePlayerBar();
    var same = activeBtn === btn && btn && !player.paused;
    if (same) {
      player.pause();
      return;
    }
    clearActive();
    player.src = src;
    player.playbackRate = currentSpeed;
    player.loop = loopOn;
    pbLabel.textContent = label;
    playerBar.classList.add("visible");
    player.play().catch(function () {});
    if (btn) {
      activeBtn = btn;
      btn.classList.add("playing");
      setBtnIcon(btn, true);
    }
  }

  function loadSpeed() {
    var v = parseFloat(localStorage.getItem(SPEED_KEY));
    return v === 0.75 || v === 1 || v === 1.25 ? v : 1;
  }

  function saveSpeed(v) {
    currentSpeed = v;
    try {
      localStorage.setItem(SPEED_KEY, String(v));
    } catch (err) {
      /* 忽略 */
    }
    player.playbackRate = v;
  }

  /* ---------------- 本地存储 ---------------- */

  function readStore(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch (err) {
      return fallback;
    }
  }

  function writeStore(key, obj) {
    try {
      localStorage.setItem(key, JSON.stringify(obj));
    } catch (err) {
      /* 忽略 */
    }
  }

  function getPracticed() {
    return readStore(PRACTICE_KEY, {});
  }

  function togglePracticed(id) {
    var p = getPracticed();
    if (p[id]) {
      delete p[id];
    } else {
      p[id] = new Date().toISOString().slice(0, 10);
    }
    writeStore(PRACTICE_KEY, p);
    return !!p[id];
  }

  function getDictation() {
    return readStore(DICTATION_KEY, {});
  }

  function getMaterialRecord(id) {
    return getDictation()[id] || {};
  }

  function setSentenceRecord(id, index, rec) {
    var all = getDictation();
    all[id] = all[id] || {};
    if (rec) {
      all[id][index] = rec;
    } else {
      delete all[id][index];
    }
    writeStore(DICTATION_KEY, all);
  }

  function resetMaterialRecord(id) {
    var all = getDictation();
    delete all[id];
    writeStore(DICTATION_KEY, all);
  }

  /* ---------------- 听写差异 ---------------- */

  function tokensOf(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  }

  function diffTokens(userTokens, answerTokens) {
    var n = userTokens.length;
    var m = answerTokens.length;
    var dp = [];
    for (var i = 0; i <= n; i++) {
      dp.push(new Array(m + 1).fill(0));
    }
    for (i = 1; i <= n; i++) {
      for (var j = 1; j <= m; j++) {
        dp[i][j] = userTokens[i - 1] === answerTokens[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
    var userFlags = new Array(n).fill(false);
    var ansFlags = new Array(m).fill(false);
    i = n;
    j = m;
    while (i > 0 && j > 0) {
      if (userTokens[i - 1] === answerTokens[j - 1]) {
        userFlags[i - 1] = true;
        ansFlags[j - 1] = true;
        i--;
        j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }
    var matched = 0;
    userFlags.forEach(function (f) { if (f) matched++; });
    return {
      userFlags: userFlags,
      ansFlags: ansFlags,
      matched: matched,
      acc: m ? matched / m : 0,
    };
  }

  function renderDiff(userText, answerText) {
    var u = tokensOf(userText);
    var a = tokensOf(answerText);
    var d = diffTokens(u, a);
    var correct = u.join(" ") === a.join(" ");
    var userHtml = u.map(function (w, i) {
      return d.userFlags[i] ? escapeHtml(w) : '<span class="diff-extra">' + escapeHtml(w) + "</span>";
    }).join(" ");
    var ansHtml = a.map(function (w, i) {
      return d.ansFlags[i] ? escapeHtml(w) : '<span class="diff-missing">' + escapeHtml(w) + "</span>";
    }).join(" ");
    return { correct: correct, acc: d.acc, userHtml: userHtml, ansHtml: ansHtml };
  }

  /* ---------------- 列表页 ---------------- */

  function chip(text) {
    var s = document.createElement("span");
    s.className = "chip";
    s.textContent = text;
    return s;
  }

  function makeCard(m, practiced, onToggle) {
    var card = document.createElement("article");
    card.className = "card material-card";
    var top = document.createElement("div");
    top.className = "card-top";
    var tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = "影子跟读 " + m.num;
    top.appendChild(tag);
    if (practiced) {
      var done = document.createElement("span");
      done.className = "practiced-badge";
      done.textContent = "已练";
      top.appendChild(done);
    }
    var date = document.createElement("span");
    date.className = "date";
    date.textContent = m.date;
    top.appendChild(date);

    var title = document.createElement("h2");
    var link = document.createElement("a");
    link.href = "read.html?id=" + encodeURIComponent(m.id);
    link.textContent = m.titleEn;
    title.appendChild(link);
    var cn = document.createElement("p");
    cn.className = "title-cn";
    cn.textContent = m.titleCn;
    var chips = document.createElement("div");
    chips.className = "chips";
    chips.appendChild(chip("全文 " + m.wordCountLabel));
    chips.appendChild(chip("音频 " + m.durationLabel));
    chips.appendChild(chip("难度 " + m.difficulty));
    chips.appendChild(chip("生词 " + m.vocabCount + " 个"));

    var actions = document.createElement("div");
    actions.className = "actions";
    var go = document.createElement("a");
    go.className = "btn btn-primary";
    go.href = link.href;
    go.textContent = "进入阅读";
    var play = document.createElement("button");
    play.className = "btn btn-ghost";
    play.dataset.src = m.audioFull;
    play.innerHTML = '<span class="icon">▶</span>播放全文';
    if (!m.audioFull) play.disabled = true;
    var mark = document.createElement("button");
    mark.className = "btn btn-ghost btn-mark" + (practiced ? " active" : "");
    mark.textContent = practiced ? "已练 ✓" : "标记已练";
    mark.addEventListener("click", function () { onToggle(m.id); });
    actions.appendChild(go);
    actions.appendChild(play);
    actions.appendChild(mark);

    card.appendChild(top);
    card.appendChild(title);
    card.appendChild(cn);
    card.appendChild(chips);
    card.appendChild(actions);
    return card;
  }

  function setupList(app, materials) {
    var state = { q: "", onlyUnpracticed: false };
    var toolbar = document.createElement("section");
    toolbar.className = "card toolbar";
    var search = document.createElement("input");
    search.type = "search";
    search.className = "search-input";
    search.placeholder = "搜索：标题 / 编号";
    var progress = document.createElement("span");
    progress.className = "progress-chip";
    var filterBtn = document.createElement("button");
    filterBtn.className = "btn btn-ghost filter-btn";
    filterBtn.textContent = "只看未练";
    var hint = document.createElement("p");
    hint.className = "toolbar-hint";
    hint.textContent = "已练进度与听写记录保存在本机浏览器";
    toolbar.appendChild(search);
    toolbar.appendChild(progress);
    toolbar.appendChild(filterBtn);
    toolbar.appendChild(hint);
    var listWrap = document.createElement("div");
    app.appendChild(toolbar);
    app.appendChild(listWrap);

    function refresh() {
      var practiced = getPracticed();
      var total = materials.length;
      var done = materials.filter(function (m) { return practiced[m.id]; }).length;
      progress.textContent = "已练 " + done + " / 共 " + total;
      filterBtn.classList.toggle("active", state.onlyUnpracticed);
      filterBtn.textContent = state.onlyUnpracticed ? "只看未练 ✓" : "只看未练";
      var q = state.q.trim().toLowerCase();
      var list = materials.filter(function (m) {
        if (state.onlyUnpracticed && practiced[m.id]) return false;
        if (!q) return true;
        return (m.titleEn + " " + m.titleCn + " " + m.num + " " + m.date).toLowerCase().indexOf(q) !== -1;
      });
      listWrap.innerHTML = "";
      if (!list.length) {
        var tip = document.createElement("div");
        tip.className = "empty-tip";
        tip.textContent = "没有符合条件的材料。";
        listWrap.appendChild(tip);
        return;
      }
      if (q || state.onlyUnpracticed) {
        list.forEach(function (m) {
          listWrap.appendChild(makeCard(m, !!practiced[m.id], onToggle));
        });
        return;
      }
      // 组号按时间从旧到新：第 1 组 = 最早的一批（含 001）；
      // 页面展示时把最新的组放在最上面，组内仍是新篇在前。
      var asc = list.slice().reverse();
      var groups = [];
      for (var i = 0; i < asc.length; i += GROUP_SIZE) {
        groups.push(asc.slice(i, i + GROUP_SIZE));
      }
      for (var gi = groups.length - 1; gi >= 0; gi--) {
        var chunk = groups[gi];
        var isNewest = gi === groups.length - 1;
        var body = document.createElement("div");
        body.className = "group-body" + (isNewest ? "" : " collapsed");
        chunk.slice().reverse().forEach(function (m) {
          body.appendChild(makeCard(m, !!practiced[m.id], onToggle));
        });
        var oldest = chunk[0];
        var newest = chunk[chunk.length - 1];
        var range = oldest.date === newest.date ? oldest.date : oldest.date + " ~ " + newest.date;
        var toggle = document.createElement("button");
        toggle.className = "group-toggle";
        toggle.innerHTML = '<span>第 ' + (gi + 1) + " 组 · " + range +
          '</span><span class="group-count">' + chunk.length + " 篇" +
          '<span class="group-arrow">' + (isNewest ? "▲" : "▼") + "</span></span>";
        toggle.addEventListener("click", function (b) {
          return function () {
            b.classList.toggle("collapsed");
            var arrow = b.querySelector(".group-arrow");
            if (arrow) arrow.textContent = b.classList.contains("collapsed") ? "▼" : "▲";
          };
        }(body));
        listWrap.appendChild(toggle);
        listWrap.appendChild(body);
      }
    }

    function onToggle(id) {
      togglePracticed(id);
      refresh();
    }

    search.addEventListener("input", function () {
      state.q = search.value;
      refresh();
    });
    filterBtn.addEventListener("click", function () {
      state.onlyUnpracticed = !state.onlyUnpracticed;
      refresh();
    });
    refresh();
  }

  /* ---------------- 跟读视图 ---------------- */

  function buildReadView(m, materials) {
    var wrap = document.createElement("div");

    var bodyCard = document.createElement("section");
    bodyCard.className = "card";
    var bodyTitle = document.createElement("h2");
    bodyTitle.className = "section-title";
    bodyTitle.textContent = "英文正文";
    bodyCard.appendChild(bodyTitle);
    m.segments.forEach(function (seg, idx) {
      var div = document.createElement("div");
      div.className = "para";
      var phead = document.createElement("div");
      phead.className = "para-head";
      var pbtn = document.createElement("button");
      pbtn.className = "btn-para";
      pbtn.dataset.label = "第 " + (idx + 1) + " 段";
      pbtn.innerHTML = '<span class="icon">▶</span><span>第 ' + (idx + 1) + " 段</span>";
      if (seg.audio) {
        pbtn.dataset.src = seg.audio;
      } else {
        pbtn.disabled = true;
      }
      phead.appendChild(pbtn);
      div.appendChild(phead);
      var p = document.createElement("p");
      p.className = "en-text";
      p.innerHTML = m.paragraphs[idx];
      div.appendChild(p);
      bodyCard.appendChild(div);
    });
    wrap.appendChild(bodyCard);

    var vocabCard = document.createElement("section");
    vocabCard.className = "card";
    var vt = document.createElement("h2");
    vt.className = "section-title";
    vt.textContent = "生词自查表";
    vocabCard.appendChild(vt);
    if (m.vocabNote) {
      var note = document.createElement("p");
      note.className = "note";
      note.textContent = m.vocabNote;
      vocabCard.appendChild(note);
    }
    var twrap = document.createElement("div");
    twrap.className = "table-wrap vocab-table-wrap";
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    ["单词", "词性", "中文", "英文释义", "音标"].forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    var tbody = document.createElement("tbody");
    m.vocabRows.forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (cell, i) {
        var td = document.createElement("td");
        td.textContent = cell;
        if (i === 0) td.className = "w-en";
        if (i === 3) td.className = "w-def";
        if (i === 4) td.className = "w-ipa";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    twrap.appendChild(table);
    vocabCard.appendChild(twrap);
    var vcards = document.createElement("div");
    vcards.className = "vocab-cards";
    m.vocabRows.forEach(function (row) {
      var c = document.createElement("div");
      c.className = "vocab-card";
      var head = document.createElement("div");
      var w = document.createElement("span");
      w.className = "vw";
      w.textContent = row[0];
      var ipa = document.createElement("span");
      ipa.className = "vipa-sm";
      ipa.textContent = row[4] ? "/" + row[4] + "/" : "";
      var pos = document.createElement("span");
      pos.className = "vpos";
      pos.textContent = row[1];
      head.appendChild(w);
      head.appendChild(ipa);
      head.appendChild(pos);
      var cn = document.createElement("div");
      cn.className = "vcn";
      cn.textContent = row[2];
      var en = document.createElement("div");
      en.className = "ven";
      en.textContent = row[3] || "";
      c.appendChild(head);
      c.appendChild(cn);
      c.appendChild(en);
      vcards.appendChild(c);
    });
    vocabCard.appendChild(vcards);
    wrap.appendChild(vocabCard);

    var phraseCard = document.createElement("section");
    phraseCard.className = "card";
    var pt = document.createElement("h2");
    pt.className = "section-title";
    pt.textContent = "好词好句·短语积累";
    phraseCard.appendChild(pt);
    var pwrap = document.createElement("div");
    pwrap.className = "table-wrap";
    var ptable = document.createElement("table");
    var pthead = document.createElement("thead");
    var ptr = document.createElement("tr");
    ["表达", "意思", "文中出处"].forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      ptr.appendChild(th);
    });
    pthead.appendChild(ptr);
    var ptbody = document.createElement("tbody");
    m.phraseRows.forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (cell, i) {
        var td = document.createElement("td");
        td.textContent = cell;
        if (i === 0) td.className = "w-en";
        tr.appendChild(td);
      });
      ptbody.appendChild(tr);
    });
    ptable.appendChild(pthead);
    ptable.appendChild(ptbody);
    pwrap.appendChild(ptable);
    phraseCard.appendChild(pwrap);
    wrap.appendChild(phraseCard);

    var transCard = document.createElement("section");
    transCard.className = "card";
    var tt = document.createElement("h2");
    tt.className = "section-title";
    tt.textContent = "全文中文翻译";
    transCard.appendChild(tt);
    var toggleTrans = document.createElement("button");
    toggleTrans.className = "btn trans-toggle";
    toggleTrans.textContent = "展开中文翻译（建议先跟读再看）";
    var box = document.createElement("div");
    box.className = "trans-box";
    box.hidden = true;
    m.translation.forEach(function (t) {
      var p = document.createElement("p");
      p.textContent = t;
      box.appendChild(p);
    });
    toggleTrans.addEventListener("click", function () {
      var showing = !box.hidden;
      box.hidden = showing;
      toggleTrans.textContent = showing ? "展开中文翻译（建议先跟读再看）" : "收起中文翻译";
    });
    transCard.appendChild(toggleTrans);
    transCard.appendChild(box);
    wrap.appendChild(transCard);

    var idx = materials.findIndex(function (x) { return x.id === m.id; });
    var prev = idx > 0 ? materials[idx - 1] : null;
    var next = idx >= 0 && idx < materials.length - 1 ? materials[idx + 1] : null;
    var pager = document.createElement("nav");
    pager.className = "pager";
    if (prev) {
      var a1 = document.createElement("a");
      a1.className = "btn btn-ghost";
      a1.href = "read.html?id=" + encodeURIComponent(prev.id);
      a1.textContent = "← 上一篇：" + shorten(prev.titleCn);
      pager.appendChild(a1);
    }
    if (next) {
      var a2 = document.createElement("a");
      a2.className = "btn btn-ghost";
      a2.href = "read.html?id=" + encodeURIComponent(next.id);
      a2.textContent = "下一篇：" + shorten(next.titleCn) + " →";
      pager.appendChild(a2);
    }
    wrap.appendChild(pager);
    return wrap;
  }

  /* ---------------- 精听视图 ---------------- */

  function buildListenView(m) {
    var wrap = document.createElement("div");

    var statsCard = document.createElement("section");
    statsCard.className = "card listen-stats";
    var statsTitle = document.createElement("h2");
    statsTitle.className = "section-title";
    statsTitle.textContent = "精听进度";
    statsCard.appendChild(statsTitle);
    var statsLine = document.createElement("p");
    statsLine.className = "stats-line";
    var errorLine = document.createElement("p");
    errorLine.className = "stats-errors";
    statsCard.appendChild(statsLine);
    statsCard.appendChild(errorLine);
    var ctrl = document.createElement("div");
    ctrl.className = "actions";
    var onlyWrong = document.createElement("button");
    onlyWrong.className = "btn btn-ghost filter-btn";
    onlyWrong.textContent = "只重练错句";
    var resetBtn = document.createElement("button");
    resetBtn.className = "btn btn-ghost";
    resetBtn.textContent = "重置本篇记录";
    ctrl.appendChild(onlyWrong);
    ctrl.appendChild(resetBtn);
    statsCard.appendChild(ctrl);
    wrap.appendChild(statsCard);

    var listCard = document.createElement("section");
    listCard.className = "card";
    var listTitle = document.createElement("h2");
    listTitle.className = "section-title";
    listTitle.textContent = "逐句听写";
    listCard.appendChild(listTitle);
    var hint = document.createElement("p");
    hint.className = "note";
    hint.textContent = "先点播放听句子，写下你听到的内容，再点「对照答案」查看差异。";
    listCard.appendChild(hint);
    wrap.appendChild(listCard);

    var state = { onlyWrong: false };
    var cards = [];

    m.sentences.forEach(function (s, i) {
      var idx = i + 1;
      var card = document.createElement("div");
      card.className = "sentence-card";
      var head = document.createElement("div");
      head.className = "sentence-head";
      var num = document.createElement("span");
      num.className = "sentence-num";
      num.textContent = "第 " + idx + " 句";
      var play = document.createElement("button");
      play.className = "btn-para sentence-play";
      play.innerHTML = '<span class="icon">▶</span><span>播放</span>';
      if (s.audio) {
        play.dataset.src = s.audio;
        play.dataset.label = "第 " + idx + " 句";
      } else {
        play.disabled = true;
      }
      var status = document.createElement("span");
      status.className = "sentence-status";
      head.appendChild(num);
      head.appendChild(play);
      head.appendChild(status);
      card.appendChild(head);

      var input = document.createElement("textarea");
      input.className = "dictation-input";
      input.rows = 2;
      input.placeholder = "听写这一句…";
      card.appendChild(input);

      var btns = document.createElement("div");
      btns.className = "actions";
      var checkBtn = document.createElement("button");
      checkBtn.className = "btn btn-primary btn-check";
      checkBtn.textContent = "对照答案";
      btns.appendChild(checkBtn);
      card.appendChild(btns);

      var result = document.createElement("div");
      result.className = "dictation-result";
      result.hidden = true;
      var userLine = document.createElement("p");
      userLine.className = "diff-line";
      var ansLine = document.createElement("p");
      ansLine.className = "diff-line";
      var tagRow = document.createElement("div");
      tagRow.className = "tag-row";
      result.appendChild(userLine);
      result.appendChild(ansLine);
      result.appendChild(tagRow);
      card.appendChild(result);

      var tagButtons = [];
      ERROR_TAGS.forEach(function (tag) {
        var t = document.createElement("button");
        t.className = "tag-btn";
        t.textContent = tag;
        t.addEventListener("click", function () {
          var rec = getMaterialRecord(m.id)[idx] || {};
          var errs = rec.errors || [];
          if (errs.indexOf(tag) !== -1) {
            errs = errs.filter(function (x) { return x !== tag; });
          } else {
            errs.push(tag);
          }
          rec.errors = errs;
          setSentenceRecord(m.id, idx, rec);
          t.classList.toggle("active", errs.indexOf(tag) !== -1);
          refreshStats();
        });
        tagButtons.push(t);
        tagRow.appendChild(t);
      });

      checkBtn.addEventListener("click", function () {
        var d = renderDiff(input.value, s.text);
        userLine.innerHTML = "<strong>你的答案：</strong>" + (d.userHtml || "<em>（空）</em>");
        ansLine.innerHTML = "<strong>标准答案：</strong>" + d.ansHtml;
        result.hidden = false;
        status.textContent = d.correct ? "正确 ✓" : "正确率 " + Math.round(d.acc * 100) + "%";
        status.className = "sentence-status " + (d.correct ? "ok" : "bad");
        var old = getMaterialRecord(m.id)[idx] || {};
        setSentenceRecord(m.id, idx, {
          done: true,
          correct: d.correct,
          acc: d.acc,
          errors: old.errors || [],
          answer: input.value,
          ts: new Date().toISOString().slice(0, 10),
        });
        refreshStats();
      });

      cards.push({ idx: idx, el: card, input: input, result: result, status: status, tagButtons: tagButtons });
      listCard.appendChild(card);
    });

    function applyRecord(c) {
      var rec = getMaterialRecord(m.id)[c.idx];
      c.el.classList.remove("ok", "bad");
      c.tagButtons.forEach(function (t) {
        t.classList.toggle("active", !!(rec && (rec.errors || []).indexOf(t.textContent) !== -1));
      });
      if (rec && rec.done) {
        c.el.classList.add(rec.correct ? "ok" : "bad");
        c.status.textContent = rec.correct ? "正确 ✓" : "正确率 " + Math.round((rec.acc || 0) * 100) + "%";
        c.status.className = "sentence-status " + (rec.correct ? "ok" : "bad");
        if (rec.answer !== undefined && !c.input.value) c.input.value = rec.answer;
      } else {
        c.status.textContent = "";
        c.status.className = "sentence-status";
      }
    }

    function visible(c) {
      var rec = getMaterialRecord(m.id)[c.idx];
      if (!state.onlyWrong) return true;
      return !!(rec && rec.done && !rec.correct);
    }

    function refreshStats() {
      var rec = getMaterialRecord(m.id);
      var done = 0;
      var ok = 0;
      var errCount = {};
      ERROR_TAGS.forEach(function (t) { errCount[t] = 0; });
      Object.keys(rec).forEach(function (k) {
        var r = rec[k];
        if (r && r.done) {
          done++;
          if (r.correct) ok++;
          (r.errors || []).forEach(function (t) { if (errCount[t] !== undefined) errCount[t]++; });
        }
      });
      var total = m.sentences.length;
      var acc = done ? Math.round((ok / done) * 100) : 0;
      statsLine.textContent = "已练 " + done + " / " + total + " 句 · 正确率 " + acc + "%";
      errorLine.textContent = "错因分布：" + ERROR_TAGS.map(function (t) {
        return t + " " + (errCount[t] || 0);
      }).join(" · ");
      cards.forEach(function (c) {
        applyRecord(c);
        c.el.hidden = !visible(c);
      });
    }

    onlyWrong.addEventListener("click", function () {
      state.onlyWrong = !state.onlyWrong;
      onlyWrong.classList.toggle("active", state.onlyWrong);
      onlyWrong.textContent = state.onlyWrong ? "只重练错句 ✓" : "只重练错句";
      refreshStats();
    });
    resetBtn.addEventListener("click", function () {
      resetMaterialRecord(m.id);
      cards.forEach(function (c) {
        c.input.value = "";
        c.result.hidden = true;
      });
      refreshStats();
    });
    refreshStats();
    return wrap;
  }

  function shorten(text) {
    text = String(text || "");
    return text.length > 12 ? text.slice(0, 12) + "…" : text;
  }

  /* ---------------- 阅读页 ---------------- */

  function setupRead(reader, materials, m) {
    document.title = "影子跟读 " + m.num + "｜" + m.titleEn;
    currentSpeed = loadSpeed();
    ensurePlayerBar();
    pbSpeed.value = String(currentSpeed);
    playerBar.classList.add("visible");

    var practiced = !!getPracticed()[m.id];
    var markBtn = null;
    function updateMark() {
      if (!markBtn) return;
      markBtn.textContent = practiced ? "已练 ✓（点击取消）" : "标记已练";
      markBtn.classList.toggle("active", practiced);
    }

    var head = document.createElement("section");
    head.className = "article-head";
    var h1 = document.createElement("h1");
    h1.textContent = "影子跟读 " + m.num;
    var h2 = document.createElement("h2");
    h2.textContent = m.titleEn;
    var cn = document.createElement("p");
    cn.className = "title-cn";
    cn.textContent = m.titleCn;
    var chips = document.createElement("div");
    chips.className = "chips";
    chips.appendChild(chip("全文 " + m.wordCountLabel));
    chips.appendChild(chip("音频 " + m.durationLabel));
    chips.appendChild(chip("难度 " + m.difficulty));
    chips.appendChild(chip("生词 " + m.vocabCount + " 个"));
    head.appendChild(h1);
    head.appendChild(h2);
    head.appendChild(cn);
    head.appendChild(chips);
    var actions = document.createElement("div");
    actions.className = "actions";
    var fullBtn = document.createElement("button");
    fullBtn.className = "btn btn-primary";
    fullBtn.dataset.src = m.audioFull;
    fullBtn.dataset.label = "整篇音频";
    fullBtn.innerHTML = '<span class="icon">▶</span>播放全文';
    if (!m.audioFull) fullBtn.disabled = true;
    markBtn = document.createElement("button");
    markBtn.className = "btn btn-ghost btn-mark";
    markBtn.addEventListener("click", function () {
      practiced = togglePracticed(m.id);
      updateMark();
    });
    actions.appendChild(fullBtn);
    actions.appendChild(markBtn);
    head.appendChild(actions);
    reader.appendChild(head);
    updateMark();

    var modeSwitch = document.createElement("div");
    modeSwitch.className = "mode-switch";
    var btnRead = document.createElement("button");
    btnRead.className = "mode-btn";
    btnRead.textContent = "跟读模式";
    var btnListen = document.createElement("button");
    btnListen.className = "mode-btn";
    btnListen.textContent = "精听模式";
    modeSwitch.appendChild(btnRead);
    modeSwitch.appendChild(btnListen);
    reader.appendChild(modeSwitch);

    var readView = buildReadView(m, materials);
    var listenView = buildListenView(m);
    reader.appendChild(readView);
    reader.appendChild(listenView);

    function setMode(mode) {
      var listen = mode === "listen";
      readView.hidden = listen;
      listenView.hidden = !listen;
      btnRead.classList.toggle("active", !listen);
      btnListen.classList.toggle("active", listen);
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch (err) {
        /* 忽略 */
      }
    }
    btnRead.addEventListener("click", function () { setMode("read"); });
    btnListen.addEventListener("click", function () { setMode("listen"); });
    var saved = "read";
    try {
      saved = localStorage.getItem(MODE_KEY) || "read";
    } catch (err) {
      saved = "read";
    }
    setMode(saved === "listen" ? "listen" : "read");
  }

  function onDataClick(e) {
    var btn = e.target.closest("[data-src]");
    if (!btn) return;
    playItem(btn.dataset.src, btn.dataset.label || "音频", btn);
  }

  async function loadMaterials() {
    var res = await fetch(DATA_URL, { cache: "no-cache" });
    if (!res.ok) throw new Error("数据加载失败：" + res.status);
    return res.json();
  }

  async function boot() {
    try {
      var data = await loadMaterials();
      var materials = Array.isArray(data) ? data : data.materials;
      var app = qs("#app");
      if (app) {
        setupList(app, materials);
        app.addEventListener("click", onDataClick);
        return;
      }
      var reader = qs("#reader");
      if (reader) {
        var id = new URLSearchParams(location.search).get("id");
        var m = materials.find(function (x) { return x.id === id; });
        if (!m) {
          reader.innerHTML = '<div class="empty-tip">没有找到这篇材料，<a href="index.html">回到列表</a>。</div>';
          return;
        }
        setupRead(reader, materials, m);
        reader.addEventListener("click", onDataClick);
      }
    } catch (err) {
      var target = qs("#app") || qs("#reader");
      if (target) target.innerHTML = '<div class="empty-tip">页面加载失败：' + escapeHtml(err.message) + "</div>";
    }
  }

  boot();
})();
