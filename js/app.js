/* Anki Web Player
 * A fully client-side .apkg viewer. Decks are unzipped with JSZip and the
 * embedded SQLite collection is read with sql.js (WASM). Nothing is uploaded.
 *
 * Supports both the legacy export format (collection.anki2 / collection.anki21
 * with a JSON media map) and the newer format (collection.anki21b plus a
 * protobuf media map, both zstd-compressed) via fzstd.
 */
(() => {
  "use strict";

  const CDN_WASM = "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/";
  const FIELD_SEP = "\x1f"; // Anki separates note fields with the 0x1f char.

  // ----- DOM -----
  const el = (id) => document.getElementById(id);
  const uploadScreen = el("upload-screen");
  const studyScreen = el("study-screen");
  const dropzone = el("dropzone");
  const fileInput = el("file-input");
  const pickBtn = el("pick-btn");
  const uploadStatus = el("upload-status");
  const deckSelect = el("deck-select");
  const progressEl = el("progress");
  const cardFrame = el("card-frame");
  const showBtn = el("show-btn");
  const prevBtn = el("prev-btn");
  const nextBtn = el("next-btn");
  const shuffleBtn = el("shuffle-btn");
  const resetBtn = el("reset-btn");

  // ----- State -----
  let SQL = null;            // sql.js module
  let mediaMap = {};         // filename -> blob URL
  let allCards = [];         // [{nid, ord, model, fields}]
  let decks = [];            // [{id, name}]
  let cardsByDeck = {};      // deckId -> [card, ...]
  let current = [];          // active list of cards being studied
  let index = 0;
  let answerShown = false;

  // Link the footer to this repo when served from GitHub Pages.
  try {
    const host = location.hostname; // e.g. user.github.io
    const parts = location.pathname.split("/").filter(Boolean);
    if (host.endsWith("github.io")) {
      const user = host.split(".")[0];
      const repo = parts[0] || "";
      el("repo-link").href = `https://github.com/${user}/${repo}`;
    }
  } catch (_) { /* non-fatal */ }

  // ---------------------------------------------------------------------------
  // Upload handling
  // ---------------------------------------------------------------------------
  pickBtn.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (e) => {
    if (e.target === pickBtn) return;
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("dragover");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  function setStatus(msg, isError = false) {
    uploadStatus.textContent = msg;
    uploadStatus.classList.toggle("error", isError);
  }

  async function ensureSql() {
    if (SQL) return SQL;
    setStatus("Loading SQLite engine…");
    SQL = await window.initSqlJs({ locateFile: (f) => CDN_WASM + f });
    return SQL;
  }

  async function handleFile(file) {
    const name = (file.name || "").toLowerCase();
    if (!name.endsWith(".apkg") && !name.endsWith(".colpkg")) {
      setStatus("Please choose a .apkg (or .colpkg) file.", true);
      return;
    }
    try {
      setStatus(`Reading ${file.name}…`);
      revokeMedia();
      await ensureSql();

      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);

      const db = await openCollection(zip);
      setStatus("Loading media…");
      await loadMedia(zip);

      setStatus("Parsing cards…");
      buildCards(db);
      db.close();

      if (!allCards.length) {
        setStatus("No cards found in this deck.", true);
        return;
      }
      populateDeckSelect();
      showStudyScreen();
    } catch (err) {
      console.error(err);
      setStatus("Could not read this file: " + (err.message || err), true);
    }
  }

  // ---------------------------------------------------------------------------
  // Reading the collection database out of the zip
  // ---------------------------------------------------------------------------
  async function openCollection(zip) {
    // Newest first; .anki21b is zstd-compressed.
    const candidates = ["collection.anki21b", "collection.anki21", "collection.anki2"];
    let entry = null;
    let chosen = null;
    for (const c of candidates) {
      if (zip.file(c)) { entry = zip.file(c); chosen = c; break; }
    }
    if (!entry) throw new Error("no collection database inside the package");

    let bytes = await entry.async("uint8array");
    if (chosen.endsWith("b")) bytes = zstdDecompress(bytes);
    return new SQL.Database(bytes);
  }

  function zstdDecompress(bytes) {
    if (!window.fzstd) throw new Error("zstd decompressor unavailable");
    return window.fzstd.decompress(bytes);
  }

  // ---------------------------------------------------------------------------
  // Media: filename -> object URL
  // ---------------------------------------------------------------------------
  function revokeMedia() {
    for (const url of Object.values(mediaMap)) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    mediaMap = {};
  }

  async function loadMedia(zip) {
    const mediaEntry = zip.file("media");
    if (!mediaEntry) return;

    let raw = await mediaEntry.async("uint8array");
    // The media map is JSON in legacy packages, protobuf (often zstd) in new ones.
    let map = tryParseJsonMedia(raw);
    if (!map) {
      try {
        let decoded = raw;
        if (isZstd(raw)) decoded = zstdDecompress(raw);
        map = parseProtobufMedia(decoded);
      } catch (e) {
        console.warn("media map unreadable", e);
        map = {};
      }
    }

    const tasks = [];
    for (const [num, fname] of Object.entries(map)) {
      const f = zip.file(num);
      if (!f) continue;
      tasks.push(
        f.async("uint8array").then((data) => {
          // New-format media files are individually zstd-compressed.
          if (isZstd(data)) {
            try { data = zstdDecompress(data); } catch (_) {}
          }
          const blob = new Blob([data], { type: guessMime(fname) });
          mediaMap[fname] = URL.createObjectURL(blob);
        })
      );
    }
    await Promise.all(tasks);
  }

  function tryParseJsonMedia(bytes) {
    try {
      const txt = new TextDecoder("utf-8").decode(bytes);
      const obj = JSON.parse(txt);
      if (obj && typeof obj === "object") return obj;
    } catch (_) {}
    return null;
  }

  function isZstd(bytes) {
    // zstd magic number: 0x28 B5 2F FD
    return bytes.length > 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 &&
           bytes[2] === 0x2f && bytes[3] === 0xfd;
  }

  // Minimal protobuf reader for the new media map: a repeated message where
  // each entry has field 1 = name (string). Index of the entry == file number.
  function parseProtobufMedia(bytes) {
    const map = {};
    let i = 0;
    let entryIndex = 0;
    const len = bytes.length;
    while (i < len) {
      const [tag, ni] = readVarint(bytes, i);
      i = ni;
      const field = tag >>> 3;
      const wire = tag & 0x7;
      if (field === 1 && wire === 2) {
        // top-level repeated MediaEntry message
        const [msgLen, mi] = readVarint(bytes, i);
        i = mi;
        const end = i + msgLen;
        const name = readEntryName(bytes, i, end);
        if (name) map[String(entryIndex)] = name;
        entryIndex++;
        i = end;
      } else {
        i = skipField(bytes, i, wire);
      }
    }
    return map;
  }

  function readEntryName(bytes, start, end) {
    let i = start;
    while (i < end) {
      const [tag, ni] = readVarint(bytes, i);
      i = ni;
      const field = tag >>> 3;
      const wire = tag & 0x7;
      if (field === 1 && wire === 2) {
        const [slen, si] = readVarint(bytes, i);
        i = si;
        return new TextDecoder("utf-8").decode(bytes.subarray(i, i + slen));
      }
      i = skipField(bytes, i, wire);
    }
    return null;
  }

  function readVarint(bytes, i) {
    let result = 0, shift = 0, b;
    do {
      b = bytes[i++];
      result |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return [result >>> 0, i];
  }

  function skipField(bytes, i, wire) {
    switch (wire) {
      case 0: { const [, ni] = readVarint(bytes, i); return ni; }
      case 1: return i + 8;
      case 2: { const [l, ni] = readVarint(bytes, i); return ni + l; }
      case 5: return i + 4;
      default: throw new Error("bad wire type " + wire);
    }
  }

  function guessMime(name) {
    const ext = name.split(".").pop().toLowerCase();
    const map = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
      svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp",
      mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
      flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
    };
    return map[ext] || "application/octet-stream";
  }

  // ---------------------------------------------------------------------------
  // Parsing notes, models and decks into renderable cards
  // ---------------------------------------------------------------------------
  function buildCards(db) {
    const { models, deckNames } = readModelsAndDecks(db);

    decks = Object.entries(deckNames)
      .map(([id, name]) => ({ id: String(id), name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    allCards = [];
    cardsByDeck = {};

    const res = db.exec(
      "SELECT c.nid, c.ord, c.did, n.mid, n.flds FROM cards c JOIN notes n ON c.nid = n.id"
    );
    if (!res.length) return;

    const cols = res[0].columns;
    const idx = (name) => cols.indexOf(name);
    const iNid = idx("nid"), iOrd = idx("ord"), iDid = idx("did"),
          iMid = idx("mid"), iFlds = idx("flds");

    for (const row of res[0].values) {
      const mid = String(row[iMid]);
      const model = models[mid];
      if (!model) continue;

      const fieldValues = String(row[iFlds]).split(FIELD_SEP);
      const fields = {};
      (model.flds || []).forEach((f, i) => { fields[f.name] = fieldValues[i] || ""; });

      const card = {
        nid: row[iNid],
        ord: row[iOrd],
        did: String(row[iDid]),
        model,
        fields,
      };
      allCards.push(card);
      (cardsByDeck[card.did] = cardsByDeck[card.did] || []).push(card);
    }
  }

  // Reads note types + deck names, supporting both the JSON-in-col layout and
  // the separate-tables layout used by newer schema versions.
  function readModelsAndDecks(db) {
    let models = {};
    let deckNames = {};

    // --- col.models / col.decks (legacy + most shared decks) ---
    try {
      const r = db.exec("SELECT models, decks FROM col LIMIT 1");
      if (r.length && r[0].values.length) {
        const [modelsJson, decksJson] = r[0].values[0];
        const m = safeJson(modelsJson);
        if (m && Object.keys(m).length) models = m;
        const d = safeJson(decksJson);
        if (d) {
          for (const [id, deck] of Object.entries(d)) deckNames[id] = deck.name || id;
        }
      }
    } catch (_) {}

    // --- Fallback: separate tables (newer schema) ---
    if (!Object.keys(models).length && hasTable(db, "notetypes")) {
      models = readModelsFromTables(db);
    }
    if (!Object.keys(deckNames).length && hasTable(db, "decks")) {
      try {
        const r = db.exec("SELECT id, name FROM decks");
        if (r.length) for (const [id, name] of r[0].values) deckNames[String(id)] = name;
      } catch (_) {}
    }

    return { models, deckNames };
  }

  function readModelsFromTables(db) {
    const models = {};
    try {
      const nt = db.exec("SELECT id, name, config FROM notetypes");
      if (nt.length) {
        for (const [id, name] of nt[0].values) {
          models[String(id)] = { id: String(id), name, flds: [], tmpls: [], css: "", type: 0 };
        }
      }
      // Detect cloze note types from their templates/config when possible.
      const fl = db.exec("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord");
      if (fl.length) {
        for (const [ntid, ord, name] of fl[0].values) {
          const m = models[String(ntid)];
          if (m) m.flds.push({ name, ord });
        }
      }
      const tm = db.exec("SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord");
      if (tm.length) {
        const cols = tm[0].columns;
        const ci = cols.indexOf("config");
        for (const row of tm[0].values) {
          const ntid = String(row[0]);
          const m = models[ntid];
          if (!m) continue;
          const { qfmt, afmt } = parseTemplateConfig(row[ci]);
          m.tmpls.push({ name: row[2], ord: row[1], qfmt, afmt });
        }
      }
      // Heuristic: a note type whose templates contain {{cloze: is a cloze type.
      for (const m of Object.values(models)) {
        if (m.tmpls.some((t) => /\{\{\s*cloze:/.test(t.qfmt || ""))) m.type = 1;
      }
    } catch (e) {
      console.warn("could not read note types from tables", e);
    }
    return models;
  }

  // The protobuf-encoded template config stores qfmt (field 1) and afmt
  // (field 2) as the first two length-delimited strings.
  function parseTemplateConfig(value) {
    try {
      const bytes = typeof value === "string"
        ? new TextEncoder().encode(value)
        : new Uint8Array(value);
      let i = 0;
      let qfmt = "", afmt = "";
      while (i < bytes.length) {
        const [tag, ni] = readVarint(bytes, i);
        i = ni;
        const field = tag >>> 3, wire = tag & 0x7;
        if (wire === 2) {
          const [l, si] = readVarint(bytes, i);
          i = si;
          const str = new TextDecoder("utf-8").decode(bytes.subarray(i, i + l));
          if (field === 1) qfmt = str;
          else if (field === 2) afmt = str;
          i += l;
        } else {
          i = skipField(bytes, i, wire);
        }
      }
      return { qfmt, afmt };
    } catch (_) {
      return { qfmt: "", afmt: "" };
    }
  }

  function hasTable(db, name) {
    try {
      const r = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]
      );
      return r.length > 0 && r[0].values.length > 0;
    } catch (_) { return false; }
  }

  function safeJson(s) {
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  // ---------------------------------------------------------------------------
  // Template rendering (Anki-flavoured Mustache + cloze + media)
  // ---------------------------------------------------------------------------
  function renderCard(card, showAnswer) {
    const model = card.model;
    const tmpls = model.tmpls || [];
    const isCloze = model.type === 1;

    // Cloze decks share one template; the card ordinal selects the cloze number.
    const tmpl = isCloze ? (tmpls[0] || {}) : (tmpls[card.ord] || tmpls[0] || {});
    const clozeNum = card.ord + 1;

    const qfmt = tmpl.qfmt || "{{Front}}";
    const afmt = tmpl.afmt || "{{FrontSide}}\n\n{{Back}}";

    const question = renderSide(qfmt, card.fields, { isCloze, clozeNum, side: "q" });
    let html;
    if (showAnswer) {
      const answer = renderSide(afmt, card.fields, {
        isCloze, clozeNum, side: "a", frontSide: question,
      });
      html = answer;
    } else {
      html = question;
    }

    return wrapHtml(rewriteMedia(html), model.css || "");
  }

  function renderSide(format, fields, opts) {
    let out = format;

    // {{FrontSide}} on the answer side.
    if (opts.frontSide != null) {
      out = out.replace(/\{\{\s*FrontSide\s*\}\}/g, opts.frontSide);
    }

    // Conditionals {{#Field}}...{{/Field}} and {{^Field}}...{{/Field}}.
    out = renderConditionals(out, fields);

    // Cloze fields.
    out = out.replace(/\{\{\s*cloze:([^}]+?)\s*\}\}/g, (_, fname) => {
      const text = fields[fname.trim()] || "";
      return renderCloze(text, opts.clozeNum, opts.side === "a");
    });

    // Field modifiers and plain fields.
    out = out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, expr) => {
      expr = expr.trim();
      if (expr === "FrontSide") return ""; // already handled / no front available
      if (expr.startsWith("#") || expr.startsWith("^") || expr.startsWith("/")) return m;

      let name = expr;
      let modifier = null;
      const colon = expr.indexOf(":");
      if (colon !== -1) {
        modifier = expr.slice(0, colon);
        name = expr.slice(colon + 1);
        // chained filters like {{type:cloze:Field}} — take the last segment as field
        const segs = expr.split(":");
        name = segs[segs.length - 1];
        modifier = segs[0];
      }
      name = name.trim();
      let val = fields[name];
      if (val == null) return ""; // unknown field -> empty, matches Anki

      switch (modifier) {
        case "text": return stripHtml(val);
        case "hint": return renderHint(val);
        case "type": return renderTypeBox(val);
        default: return val;
      }
    });

    return out;
  }

  function renderConditionals(text, fields) {
    const re = /\{\{\s*([#^])\s*([^}]+?)\s*\}\}/;
    let m;
    let guard = 0;
    while ((m = re.exec(text)) && guard++ < 1000) {
      const type = m[1];
      const name = m[2].trim();
      const open = m[0];
      const close = `{{/${name}}}`;
      const start = m.index;
      const innerStart = start + open.length;
      const closeIdx = text.indexOf(close, innerStart);
      if (closeIdx === -1) {
        // Unbalanced — strip the opening tag and continue.
        text = text.slice(0, start) + text.slice(innerStart);
        continue;
      }
      const inner = text.slice(innerStart, closeIdx);
      const after = text.slice(closeIdx + close.length);
      const before = text.slice(0, start);
      const nonEmpty = !!(fields[name] && String(fields[name]).trim());
      const keep = type === "#" ? nonEmpty : !nonEmpty;
      text = before + (keep ? inner : "") + after;
    }
    return text;
  }

  function renderCloze(text, num, isAnswer) {
    // {{c<n>::answer}} or {{c<n>::answer::hint}}
    const re = /\{\{c(\d+)::([\s\S]*?)\}\}/g;
    return text.replace(re, (full, n, body) => {
      const idx = body.lastIndexOf("::");
      let answer = body, hint = "";
      if (idx !== -1) { answer = body.slice(0, idx); hint = body.slice(idx + 2); }
      const active = Number(n) === num;
      if (!active) {
        // Other clozes always show their answer text.
        return answer;
      }
      if (isAnswer) {
        return `<span class="cloze">${answer}</span>`;
      }
      const placeholder = hint ? hint : "...";
      return `<span class="cloze">[${placeholder}]</span>`;
    });
  }

  function renderHint(val) {
    if (!val) return "";
    const id = "hint-" + Math.random().toString(36).slice(2);
    return `<a class="hint" href="#" onclick="document.getElementById('${id}').style.display='inline';this.style.display='none';return false;">Show hint</a>` +
           `<span id="${id}" class="hint" style="display:none">${val}</span>`;
  }

  function renderTypeBox() {
    // We don't grade typed answers; show a disabled input as a placeholder.
    return '<input type="text" class="typed" placeholder="type the answer…" />';
  }

  function stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
  }

  // Replace media references (img/audio/video src + [sound:x]) with blob URLs.
  function rewriteMedia(html) {
    // [sound:file] -> audio element
    html = html.replace(/\[sound:([^\]]+)\]/g, (_, fname) => {
      const url = mediaMap[fname.trim()];
      if (!url) return "";
      return `<audio controls preload="none" src="${url}" class="anki-audio"></audio>`;
    });

    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("[src]").forEach((node) => {
      const src = node.getAttribute("src");
      if (!src) return;
      if (mediaMap[src]) node.setAttribute("src", mediaMap[src]);
      else {
        const decoded = decodeURIComponent(src);
        if (mediaMap[decoded]) node.setAttribute("src", mediaMap[decoded]);
      }
    });
    return tmp.innerHTML;
  }

  function wrapHtml(body, css) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
       padding:24px;color:#1e293b;background:#fff;}
  .card{font-size:1.25rem;text-align:center;line-height:1.5;}
  img,video{max-width:100%;height:auto;}
  hr{border:none;border-top:1px solid #cbd5e1;margin:1.2em 0;}
  .cloze{color:#2563eb;font-weight:bold;}
  .anki-audio{display:block;margin:0.8em auto;}
  .typed{font:inherit;padding:.4em;border:1px solid #cbd5e1;border-radius:8px;width:80%;}
  a.hint{color:#2563eb;cursor:pointer;}
${css}
</style></head>
<body><div class="card">${body}</div>
<script>
  // Report height to the parent so the iframe can size itself.
  function report(){
    var h=Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    parent.postMessage({type:"anki-card-height",height:h},"*");
  }
  window.addEventListener("load",report);
  new ResizeObserver(report).observe(document.body);
  setTimeout(report,50);
<\/script>
</body></html>`;
  }

  // ---------------------------------------------------------------------------
  // Study UI
  // ---------------------------------------------------------------------------
  function populateDeckSelect() {
    deckSelect.innerHTML = "";
    const allOpt = document.createElement("option");
    allOpt.value = "__all__";
    allOpt.textContent = `All decks (${allCards.length} cards)`;
    deckSelect.appendChild(allOpt);

    decks
      .filter((d) => (cardsByDeck[d.id] || []).length)
      .forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = `${d.name} (${cardsByDeck[d.id].length})`;
        deckSelect.appendChild(opt);
      });

    selectDeck("__all__");
  }

  function selectDeck(deckId) {
    current = deckId === "__all__" ? allCards.slice() : (cardsByDeck[deckId] || []).slice();
    index = 0;
    answerShown = false;
    show();
  }

  deckSelect.addEventListener("change", () => selectDeck(deckSelect.value));

  function show() {
    if (!current.length) {
      cardFrame.srcdoc = wrapHtml("<p>No cards in this deck.</p>", "");
      progressEl.textContent = "";
      return;
    }
    index = (index + current.length) % current.length;
    const card = current[index];
    cardFrame.srcdoc = renderCard(card, answerShown);
    progressEl.textContent = `Card ${index + 1} / ${current.length}`;
    showBtn.textContent = answerShown ? "Hide Answer" : "Show Answer";
    prevBtn.disabled = current.length <= 1;
    nextBtn.disabled = current.length <= 1;
  }

  function toggleAnswer() { answerShown = !answerShown; show(); }
  function next() { index++; answerShown = false; show(); }
  function prev() { index--; answerShown = false; show(); }

  function shuffle() {
    for (let i = current.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [current[i], current[j]] = [current[j], current[i]];
    }
    index = 0;
    answerShown = false;
    show();
  }

  showBtn.addEventListener("click", toggleAnswer);
  nextBtn.addEventListener("click", next);
  prevBtn.addEventListener("click", prev);
  shuffleBtn.addEventListener("click", shuffle);
  resetBtn.addEventListener("click", () => {
    revokeMedia();
    allCards = [];
    fileInput.value = "";
    studyScreen.classList.add("hidden");
    uploadScreen.classList.remove("hidden");
    setStatus("");
  });

  // Resize iframe to fit its content.
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "anki-card-height") {
      const h = Math.max(260, Number(e.data.height) || 0);
      cardFrame.style.height = h + "px";
    }
  });

  // Keyboard shortcuts.
  document.addEventListener("keydown", (e) => {
    if (studyScreen.classList.contains("hidden")) return;
    if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!answerShown) toggleAnswer(); else next();
    } else if (e.key === "ArrowRight") {
      e.preventDefault(); next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault(); prev();
    }
  });

  function showStudyScreen() {
    uploadScreen.classList.add("hidden");
    studyScreen.classList.remove("hidden");
    setStatus("");
  }
})();
