(function () {
  "use strict";

  var PRACTICE_KEY = "shadow-practiced-v1";
  var PROGRESS_KEY = "shadow-vocab-v1";

  function readStore(key) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch (err) {
      return {};
    }
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  function setText(id, text) {
    var node = document.getElementById(id);
    if (node) node.textContent = text;
  }

  async function shadowStat() {
    try {
      var res = await fetch("materials.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var materials = Array.isArray(data) ? data : data.materials || [];
      var ids = {};
      materials.forEach(function (m) {
        ids[m.id] = true;
      });
      var practiced = readStore(PRACTICE_KEY);
      var done = Object.keys(practiced).filter(function (id) {
        return ids[id];
      }).length;
      setText("stat-shadow", "已练 " + done + " / 共 " + materials.length + " 篇");
    } catch (err) {
      setText("stat-shadow", "材料数据加载失败");
    }
  }

  async function vocabStat() {
    try {
      var res = await fetch("vocab.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var data = await res.json();
      var cards = Array.isArray(data) ? data : data.cards || [];
      var progress = readStore(PROGRESS_KEY);
      var records = progress.cards || {};
      var today = todayStr();
      var due = 0;
      var fresh = 0;
      cards.forEach(function (c) {
        var rec = records[c.id];
        if (!rec) {
          fresh += 1;
          return;
        }
        if (rec.due && rec.due <= today) due += 1;
      });
      setText("stat-vocab", "今日待复习 " + due + " · 未学 " + fresh);
    } catch (err) {
      setText("stat-vocab", "词库加载失败");
    }
  }

  shadowStat();
  vocabStat();
})();
