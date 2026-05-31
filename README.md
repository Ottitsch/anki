# 🃏 Anki Web Player

A small, **fully client-side** website for studying Anki decks. Drop in an
`.apkg` file and flip through its cards right in the browser — no install, no
account, and **nothing is ever uploaded** to a server. The file is unzipped and
read entirely in your browser.

## Features

- Drag & drop (or pick) `.apkg` / `.colpkg` files
- Reads the embedded SQLite collection with [sql.js](https://sql.js.org/) (WASM)
- Renders cards using Anki's template syntax:
  - field substitution `{{Field}}`
  - conditionals `{{#Field}}…{{/Field}}` / `{{^Field}}…{{/Field}}`
  - cloze deletions `{{cloze:Text}}` with `{{c1::…::hint}}`
  - `{{FrontSide}}`, `{{type:…}}`, `{{hint:…}}`, `{{text:…}}`
- Per–note-type CSS, images, and `[sound:…]` audio (rendered with the deck's media)
- Deck filter, previous/next navigation, shuffle, and keyboard shortcuts
- Supports both the legacy export format and the newer zstd/protobuf format

## How it works

Everything runs in the visitor's browser:

1. [JSZip](https://stuk.github.io/jszip/) unzips the package.
2. The collection database (`collection.anki2` / `.anki21` / `.anki21b`) is read
   with sql.js. The `.anki21b` variant is zstd-decompressed with
   [fzstd](https://github.com/101arrowz/fzstd).
3. Note types, fields, decks, and media are parsed and cards are rendered into a
   sandboxed `<iframe>` so each deck's own CSS stays isolated.

## Running locally

It's a static site, so any static file server works:

```bash
# from the repo root
python3 -m http.server 8000
# then open http://localhost:8000
```

(Opening `index.html` directly via `file://` also mostly works, but a local
server avoids browser restrictions on WASM/iframes.)

## Hosting on GitHub Pages

Two options:

**A. GitHub Actions (recommended)** — a workflow is included at
`.github/workflows/deploy-pages.yml`.
1. Merge this branch into `main`.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow deploys on every push to `main`. Your site appears at
   `https://<user>.github.io/<repo>/`.

**B. Deploy from a branch** — since the site is plain static files at the repo
root, you can instead set **Settings → Pages → Source: Deploy from a branch**
and pick a branch with `/ (root)`.

## Notes & limitations

- This is a **viewer/player**, not a scheduler — it doesn't track reviews, due
  dates, or save progress.
- Typed-answer cards (`{{type:…}}`) show an input box but answers aren't graded.
- Decks exported from very new Anki versions are supported, but exotic add-on
  card templates that rely on JavaScript may not render perfectly.

## Libraries

Loaded from CDN at runtime: JSZip, sql.js (+ WASM), and fzstd. No build step.
