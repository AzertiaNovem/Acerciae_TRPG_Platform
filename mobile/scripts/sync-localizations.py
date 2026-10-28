#!/usr/bin/env python3
"""Package reviewed mobile aliases and the web catalog for both native apps."""
from pathlib import Path
import json
root = Path(__file__).resolve().parents[2]
folder = root / 'mobile/contracts/localization'
catalog = json.loads((root / 'frontend/src/i18n/catalog.json').read_text())
for line in (folder / 'mobile.tsv').read_text().splitlines():
    if not line.strip(): continue
    key, *translations = line.split('\t')
    assert len(translations) == 10, key
    catalog[key] = translations
aliases = json.loads((folder / 'aliases.json').read_text())
assert not set(aliases.values()) - catalog.keys(), set(aliases.values()) - catalog.keys()
for key, translations in catalog.items():
    assert len(translations) == 10 and all(translations), key
# First exact Chinese match wins; explicit aliases take precedence over ambiguous web labels.
for key, translations in catalog.items(): aliases.setdefault(translations[0], key)
data = json.dumps({'catalog': catalog, 'aliases': aliases}, ensure_ascii=False, indent=2) + '\n'
for path in [root/'mobile/ios/App/Localization/mobile-localizations.json', root/'mobile/android/app/src/main/assets/mobile-localizations.json']:
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(data)
print(f'{len(catalog)} entries, 11 languages; packaged for iOS and Android')
