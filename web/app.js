(function () {
  "use strict";

  var DATA_URL = "materials.json";
  var GROUP_SIZE = 10;
  var PRACTICE_KEY = "shadow-practiced-v1";
  var SPEED_KEY = "shadow-speed-v1";

  var player = null;
  var activeBtn = null;
  var activeLoopBtn = null;
  var currentSpeed = 1;

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

  function setBtnIcon(btn, playing) {
    if (!btn) return;
    btn.dataset.playing = playing ? "1" : "0";
    var icon = btn.querySelector(".icon");
    if (icon) icon.textContent = playing ? "❚❚" : "▶";
  }

  function clearLoopBtn() {
    if (activeLoopBtn) {
      activeLoopBtn.classList.remove("active");
      activeLoopBtn = null;
    }
  }

  function stopAll() {
    if (player) {
      player.pause();
      player.currentTime = 0;
      player.loop = false;
    }
    if (activeBtn) setBtnIcon(activeBtn, false);
    activeBtn = null;
    clearLoopBtn();
  }

  function playSrc(src, btn, loop) {
    if (!src) return;
    var same = player && activeBtn === btn && !player.paused;
    stopAll();
    if (same) return;
    if (!player) player = new Audio();
    player.src = src;
    player.loop = !!loop;
    player.playbackRate = currentSpeed;
    player.play().catch(function () {
      if (activeBtn === btn) setBtnIcon(btn, false);
    });
    activeBtn = btn;
    if (loop) {
      btn.classList.add("active");
      activeLoopBtn = btn;
    } else {
      setBtnIcon(btn, true);
    }
    player.onended = function () {
      if (activeBtn) setBtnIcon(activeBtn, false);
      activeBtn = null;
      clearLoopBtn();
    };
  }

  function getPracticed() {
    try {
      return JSON.parse(localStorage.getItem(PRACTICE_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function savePracticed(obj) {
    try {
      localStorage.setItem(PRACTICE_KEY, JSON.stringify(obj));
    } catch (err) {
      /* 忽略存储失败（隐私模式等） */
    }
  }

  function togglePracticed(id) {
    var p = getPracticed();
    if (p[id]) {
      delete p[id];
    } else {
      p[id] = new Date().toISOString().slice(0, 10);
    }
    savePracticed(p);
    return !!p[id];
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
    if (player) player.playbackRate = v;
  }

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
    play.dataset.label = "整篇音频";
    play.innerHTML = '<span class="icon">▶</span>播放全文';
    if (!m.audioFull) play.disabled = true;
    var mark = document.createElement("button");
    mark.className = "btn btn-ghost btn-mark" + (practiced ? " active" : "");
    mark.textContent = practiced ? "已练 ✓" : "标记已练";
    mark.addEventListener("click", function () {
      onToggle(m.id);
    });
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
    hint.textContent = "已练进度保存在本机浏览器";
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
        var hay = (m.titleEn + " " + m.titleCn + " " + m.num + " " + m.date).toLowerCase();
        return hay.indexOf(q) !== -1;
      });

      listWrap.innerHTML = "";
      if (!list.length) {
        var tip = document.createElement("div");
        tip.className = "empty-tip";
        tip.textContent = q || state.onlyUnpracticed ? "没有符合条件的材料。" : "还没有材料。";
        listWrap.appendChild(tip);
        return;
      }
      if (q || state.onlyUnpracticed) {
        list.forEach(function (m) {
          listWrap.appendChild(makeCard(m, !!practiced[m.id], onToggle));
        });
        return;
      }
      for (var i = 0; i < list.length; i += GROUP_SIZE) {
        var chunk = list.slice(i, i + GROUP_SIZE);
        var groupIndex = i / GROUP_SIZE;
        var body = document.createElement("div");
        body.className = "group-body" + (groupIndex === 0 ? "" : " collapsed");
        chunk.forEach(function (m) {
          body.appendChild(makeCard(m, !!practiced[m.id], onToggle));
        });
        var toggle = document.createElement("button");
        toggle.className = "group-toggle";
        var first = chunk[0];
        var last = chunk[chunk.length - 1];
        var range = first.date === last.date ? first.date : last.date + " ~ " + first.date;
        toggle.innerHTML = '<span>第 ' + (groupIndex + 1) + " 组 · " + range +
          '</span><span class="group-count">' + chunk.length + " 篇" +
          '<span class="group-arrow">' + (groupIndex === 0 ? "▲" : "▼") + "</span></span>";
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

  function buildVocabSection(m) {
    var vocabCard = document.createElement("section");
    vocabCard.className = "card";
    var title = document.createElement("h2");
    title.className = "section-title";
    title.textContent = "生词自查表";
    vocabCard.appendChild(title);
    if (m.vocabNote) {
      var note = document.createElement("p");
      note.className = "note";
      note.textContent = m.vocabNote;
      vocabCard.appendChild(note);
    }

    var wrap = document.createElement("div");
    wrap.className = "table-wrap vocab-table-wrap";
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var tr = document.createElement("tr");
    ["单词", "词性", "中文", "英文释义"].forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    var tbody = document.createElement("tbody");
    m.vocabRows.forEach(function (row) {
      var r = document.createElement("tr");
      row.forEach(function (cell, i) {
        var td = document.createElement("td");
        td.textContent = cell;
        if (i === 0) td.className = "w-en";
        if (i === 3) td.className = "w-def";
        r.appendChild(td);
      });
      tbody.appendChild(r);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(table);
    vocabCard.appendChild(wrap);

    var cards = document.createElement("div");
    cards.className = "vocab-cards";
    m.vocabRows.forEach(function (row) {
      var c = document.createElement("div");
      c.className = "vocab-card";
      var head = document.createElement("div");
      var w = document.createElement("span");
      w.className = "vw";
      w.textContent = row[0];
      var pos = document.createElement("span");
      pos.className = "vpos";
      pos.textContent = row[1];
      head.appendChild(w);
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
      cards.appendChild(c);
    });
    vocabCard.appendChild(cards);
    return vocabCard;
  }

  function setupRead(reader, materials, m) {
    document.title = "影子跟读 " + m.num + "｜" + m.titleEn;
    currentSpeed = loadSpeed();
    var practiced = !!getPracticed()[m.id];
    var markButtons = [];

    function markText() {
      return practiced ? "已练 ✓（点击取消）" : "标记已练";
    }

    function updateMarks() {
      markButtons.forEach(function (b) {
        b.textContent = markText();
        b.classList.toggle("active", practiced);
      });
    }

    function onMark() {
      practiced = togglePracticed(m.id);
      updateMarks();
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

    var fullBox = document.createElement("div");
    fullBox.className = "actions";
    var fullBtn = document.createElement("button");
    fullBtn.className = "btn btn-primary";
    fullBtn.dataset.src = m.audioFull;
    fullBtn.dataset.label = "整篇音频";
    fullBtn.innerHTML = '<span class="icon">▶</span>播放全文';
    if (!m.audioFull) fullBtn.disabled = true;
    var markBtn = document.createElement("button");
    markBtn.className = "btn btn-ghost btn-mark" + (practiced ? " active" : "");
    markBtn.addEventListener("click", onMark);
    markButtons.push(markBtn);
    fullBox.appendChild(fullBtn);
    fullBox.appendChild(markBtn);
    head.appendChild(fullBox);

    var speedRow = document.createElement("div");
    speedRow.className = "speed-row";
    var speedLabel = document.createElement("span");
    speedLabel.className = "speed-label";
    speedLabel.textContent = "播放速度";
    var speedSel = document.createElement("select");
    speedSel.className = "styled";
    [["0.75", "0.75×"], ["1", "1.0×"], ["1.25", "1.25×"]].forEach(function (opt) {
      var o = document.createElement("option");
      o.value = opt[0];
      o.textContent = opt[1];
      if (parseFloat(opt[0]) === currentSpeed) o.selected = true;
      speedSel.appendChild(o);
    });
    speedSel.addEventListener("change", function () {
      saveSpeed(parseFloat(speedSel.value));
    });
    speedRow.appendChild(speedLabel);
    speedRow.appendChild(speedSel);
    head.appendChild(speedRow);
    reader.appendChild(head);
    updateMarks();

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
        pbtn.title = "该段音频暂不可用";
      }
      var loopBtn = document.createElement("button");
      loopBtn.className = "btn-loop";
      loopBtn.textContent = "🔁 循环";
      if (seg.audio) {
        loopBtn.dataset.loopSrc = seg.audio;
        loopBtn.title = "循环播放本段";
      } else {
        loopBtn.disabled = true;
      }
      phead.appendChild(pbtn);
      phead.appendChild(loopBtn);
      div.appendChild(phead);
      var p = document.createElement("p");
      p.className = "en-text";
      p.innerHTML = m.paragraphs[idx];
      div.appendChild(p);
      bodyCard.appendChild(div);
    });
    reader.appendChild(bodyCard);

    reader.appendChild(buildVocabSection(m));

    var phraseCard = document.createElement("section");
    phraseCard.className = "card";
    var phraseTitle = document.createElement("h2");
    phraseTitle.className = "section-title";
    phraseTitle.textContent = "好词好句·短语积累";
    phraseCard.appendChild(phraseTitle);
    var wrap2 = document.createElement("div");
    wrap2.className = "table-wrap";
    var table2 = document.createElement("table");
    var thead2 = document.createElement("thead");
    var tr2 = document.createElement("tr");
    ["表达", "意思", "文中出处"].forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      tr2.appendChild(th);
    });
    thead2.appendChild(tr2);
    var tb2 = document.createElement("tbody");
    m.phraseRows.forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (cell, i) {
        var td = document.createElement("td");
        td.textContent = cell;
        if (i === 0) td.className = "w-en";
        tr.appendChild(td);
      });
      tb2.appendChild(tr);
    });
    table2.appendChild(thead2);
    table2.appendChild(tb2);
    wrap2.appendChild(table2);
    phraseCard.appendChild(wrap2);
    reader.appendChild(phraseCard);

    var transCard = document.createElement("section");
    transCard.className = "card";
    var transTitle = document.createElement("h2");
    transTitle.className = "section-title";
    transTitle.textContent = "全文中文翻译";
    transCard.appendChild(transTitle);
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
    reader.appendChild(transCard);

    var markBottom = document.createElement("button");
    markBottom.className = "btn btn-ghost btn-mark" + (practiced ? " active" : "");
    markBottom.addEventListener("click", onMark);
    markButtons.push(markBottom);
    updateMarks();

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
    reader.appendChild(pager);
    reader.appendChild(markBottom);
  }

  function shorten(text) {
    text = String(text || "");
    return text.length > 12 ? text.slice(0, 12) + "…" : text;
  }

  function onDataClick(e) {
    var loopBtn = e.target.closest("[data-loop-src]");
    if (loopBtn) {
      playSrc(loopBtn.dataset.loopSrc, loopBtn, true);
      return;
    }
    var btn = e.target.closest("[data-src]");
    if (btn) playSrc(btn.dataset.src, btn, false);
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
