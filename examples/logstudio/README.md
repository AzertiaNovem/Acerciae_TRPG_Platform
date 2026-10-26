# Log Studio fixtures

These are authored test examples, not real player records or canned production outputs. Import `canonical.json`, `sealdice-105.json`, `sealdice.txt` or `rendered.txt` through Import, inspect the preview, map nicknames and commit. The SealDice JSON shape was checked against the pinned upstream source described in `docs/LOG_STUDIO.md`; version 105 is the tested fixture version.

Select a public-player snapshot and use `pdf-classic.json`, `pdf-dossier.json` or `pdf-novel.json` as the config in a PDF request. They contain no external images. Upload and approve your own cover/illustrations, then fill in their returned IDs. The actual PDF is rendered by the worker from snapshot data.

`voices.json` illustrates real Qwen and explicitly mock profiles plus a pronunciation dictionary. Create campaign characters first and use their returned IDs; do not submit the wrapper object directly to the voices endpoint. Confirm cloud processing and regional credentials before live synthesis.

`presentation-reference.json` documents the existing manual timeline data shape. Its illustrative IDs must be replaced with API-returned IDs. It is not a visual-novel template generator. The application can create the existing basic presentation from a snapshot, then accept user edits and uploaded media.
