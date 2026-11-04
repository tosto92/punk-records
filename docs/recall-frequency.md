# Recall lexical frequencies

`lib/data/recall-frequency.json` contains measured word frequencies from **wordfreq 3.1.1**, rather than a hand-maintained stopword list. It has 7,544 Italian and 7,080 English entries and is 217,000 bytes (under 256 KiB). Runtime needs neither Python nor network access.

## Provenance and redistribution

The pinned [wordfreq release](https://pypi.org/project/wordfreq/3.1.1/) explicitly permits data redistribution under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Its software has a separate Apache license. This filtered data derivative retains CC BY-SA 4.0. Keep the adjacent `lib/data/recall-frequency-NOTICE.md` with it when packaging or redistributing. That notice preserves the release README's licensing section and source citations, including Robyn Speer, OpenSubtitles, and Marc Brysbaert et al.; SUBTLEX is freely available data. These are the upstream distributor's documented permissions, not an independent audit of each original corpus.

The JSON metadata records the exact source archive URL and SHA-256, wheel SHA-256, and SHA-256 of each compressed input language list. The verified archive hash is `7943098975f25c2a70e1151ee5a62083b14a5f86f6cc5703cc9526f716ceb408`; the JSON SHA-256 is `a3ed5c59ff085c4830b980dfca57c9cb6a2638dd65cc10f9f2a59657639a5520`.

## Meaning and limits

Values are Zipf frequencies: `log10(occurrences per billion words)`, rounded to two decimal places as upstream bins already are. Higher means more common and therefore less useful as a specific recall clue. Zipf 4 is roughly one occurrence per 100,000 words, 6 roughly one per 1,000. The retained observed range is 4.00–7.73 (Italian maximum 7.59). The frequencies summarize general written-language corpora, not developer command usage.

Selection is deterministic: use each `large` language list, retain NFC lowercase alphabetic tokens whose rounded Zipf frequency is at least 4, then sort by token. No frequencies or individual tokens are manually overridden. Examples: Italian `fatto` 6.19, `va` 5.73, `bene` 5.92; English `commit` 4.33 and `main` 5.24.

Use the maximum observed IT/EN value when the prompt language is unknown. Normalize lookup tokens to NFC lowercase. Missing means below the export cutoff **or** missing from the underlying source; it is not a measured zero and does not establish rarity. Expose `lexicalUnknown` and require bounded local evidence for absent identifiers rather than treating their absence as strong specificity. Technical identifiers, punctuation, digits, and other languages have limited or no coverage.

## Reproduce and verify

From the repository root, create a disposable environment (no repository dependency changes):

```sh
rtk python3 -m venv /tmp/recall-frequency-rebuild
rtk /tmp/recall-frequency-rebuild/bin/pip install wordfreq==3.1.1
rtk /tmp/recall-frequency-rebuild/bin/python - <<'PYTHON'
import hashlib, json, math, unicodedata
from pathlib import Path
from wordfreq import available_languages, get_frequency_dict

path = Path('lib/data/recall-frequency.json')
original = path.read_bytes()
asset = json.loads(original)
asset['languages'] = {}
for lang in ('it', 'en'):
    source = Path(available_languages(wordlist='large')[lang])
    assert hashlib.sha256(source.read_bytes()).hexdigest() == asset['metadata']['sourceData'][lang]['sha256']
    asset['languages'][lang] = dict(sorted(
        (token, round(9 + math.log10(freq), 2))
        for token, freq in get_frequency_dict(lang, wordlist='large').items()
        if token.isalpha() and token == token.lower()
        and unicodedata.normalize('NFC', token) == token
        and round(9 + math.log10(freq), 2) >= 4
    ))
rebuilt = (json.dumps(asset, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
assert rebuilt == original
assert len(rebuilt) <= 256 * 1024
assert [len(asset['languages'][lang]) for lang in ('it', 'en')] == [7544, 7080]
assert all(4 <= value <= 9 for words in asset['languages'].values() for value in words.values())
assert [asset['languages']['it'][word] for word in ('fatto', 'va', 'bene')] == [6.19, 5.73, 5.92]
assert [asset['languages']['en'][word] for word in ('commit', 'main')] == [4.33, 5.24]
assert all('c43b0ce' not in words for words in asset['languages'].values())
print(len(rebuilt), hashlib.sha256(rebuilt).hexdigest())
PYTHON
```

The language dictionaries are regenerated entirely; provenance metadata is preserved. The compressed source hashes detect unexpected changes to the pinned distribution. Upstream helper dependencies are temporary extraction tools only, and their versions do not change the hashed source frequencies.
