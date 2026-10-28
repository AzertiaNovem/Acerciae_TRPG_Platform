# Log Studio fixtures

These are authored test examples, not real player records or canned production outputs. The campaign log is no longer imported: it is synced from the channel's own chat. `canonical.json`, `sealdice-105.json`, `sealdice.txt` and `rendered.txt` show the shapes the exports produce (native JSON, SealDice JSON per chat window, SealDice text, plain text); the SealDice JSON shape was checked against the pinned upstream source described in `docs/LOG_STUDIO.md`, version 105.

Select a public-player snapshot and use `pdf-classic.json`, `pdf-dossier.json` or `pdf-novel.json` as the config in a PDF request. They contain no external images. Upload and approve your own cover/illustrations, then fill in their returned IDs. The actual PDF is rendered by the worker from snapshot data.

`voices.json` illustrates real Qwen and explicitly mock profiles plus a pronunciation dictionary. Create campaign characters first and use their returned IDs; do not submit the wrapper object directly to the voices endpoint. Confirm cloud processing and regional credentials before live synthesis.

`vn-template-dossier.json` is a look template for `settings.template` (see `docs/VISUAL_NOVEL.md`); replace the character id. `presentation-reference.json` documents the existing manual timeline data shape. Its illustrative IDs must be replaced with API-returned IDs. The application can create the existing basic presentation from a snapshot, then accept user edits and uploaded media.
