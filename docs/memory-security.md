# Optional memory protection

Punk Records can scan compiled memories with pinned NOVA before recall. Protection
requires `PUNK_RECORDS_SECURITY=1`; unconfigured installs are unprotected. The
scanner runs locally without model downloads, credentials, provider calls, a
daemon, or a cache. Installation is a separate, networked operator action; scanning
never installs or updates anything.

## Set up and launch

Use Python 3.10 or later and a dedicated virtual environment. The npm artifact
includes the bridge, requirement, rules, manifest, and upstream license under
`lib/security/`. Find that directory in your installed package; for a global npm
install it is normally `$(npm root -g)/punk-records/lib/security`.
From a checkout:

```sh
python3.10 -m venv "$HOME/.local/share/punk-records-nova-venv"
"$HOME/.local/share/punk-records-nova-venv/bin/python" -m pip install -r lib/security/requirements.txt
export PUNK_RECORDS_PYTHON="$HOME/.local/share/punk-records-nova-venv/bin/python"
punk-records scan --global
PUNK_RECORDS_SECURITY=1 claude
PUNK_RECORDS_SECURITY=1 codex
PUNK_RECORDS_SECURITY=1 opencode
```

`PUNK_RECORDS_PYTHON` must name the interpreter, preferably an absolute path; paths
containing spaces work. Without it the scanner tries `python3`. Export it into
the agent's environment and explicitly set `PUNK_RECORDS_SECURITY=1` when launching
every protected agent so hooks and MCP subprocesses inherit both variables.
`init` and plugin installation do not enable protection. An unavailable/wrong
interpreter or engine makes protected recall incomplete and excludes affected
memories; it does not silently disable the gate.

The engine is `nova-hunting==0.3.1`. The verified upstream wheel SHA-256 is
`b7c529e7d54b996f73a83e124ca102588cdc421428b5dd46b146244e493bdbc0`.
`requirements.txt` pins the version; it does not enforce the wheel hash. To verify
the artifact before installation:

```sh
mkdir nova-wheel
"$PUNK_RECORDS_PYTHON" -m pip download --no-deps --only-binary=:all: nova-hunting==0.3.1 -d nova-wheel
"$PUNK_RECORDS_PYTHON" -c 'import hashlib,pathlib; p, = pathlib.Path("nova-wheel").glob("*.whl"); assert hashlib.sha256(p.read_bytes()).hexdigest() == "b7c529e7d54b996f73a83e124ca102588cdc421428b5dd46b146244e493bdbc0", "wheel hash mismatch"'
"$PUNK_RECORDS_PYTHON" -m pip install nova-wheel/*.whl
```

This verifies the NOVA wheel, not its transitive dependencies. No Python engine is
bundled or automatically installed by Punk Records.

## Scan and interpret results

```sh
punk-records scan --local
punk-records scan --global
punk-records scan --local --rules /absolute/path/to/experimental-rules
```

`scan` and `review` run independently of `PUNK_RECORDS_SECURITY`. They default to
the nearest project store, or global outside a project. `--local` requires a git
repository or `.punk-records` (or legacy `.previously`) marker; `--global` selects only the global store.
`scan` prints escaped JSON containing scanner identity, every compiled memory
version, field-attributed matches, incomplete rule evidence, and stable reason
codes. It scans original fields and their combined representation before ranking
or recall truncation. It never truncates input and calls it clean.

| Result | Meaning | Protected recall |
|---|---|---|
| `no_signals` | Evaluation completed with no configured-rule detections | Included as reference data |
| `suspicious` | At least one definite detection | Excluded unless an exact human exception applies |
| `incomplete` | Evaluation could not finish and has no definite detection | Excluded; approval disabled |

A suspicious result can also carry incomplete evidence from another rule; it
stays excluded and cannot be approved. Exit **2** means any error or incomplete
evidence, even with detections; otherwise **1** means a detection; otherwise **0**
means no detections. An empty store can still report a scanner error. Scanner
results never prove truth, certify safety, authorize tools, or override the human's
instructions. Memory text claiming to be approved has no effect.

Protected `ask`, hooks, MCP recall, and agent adapters share the gate. Hooks report
exclusions without questions or passing excluded payloads to the agent. A
successfully committed save remains saved if scanning subsequently fails; inspect
the diagnostic and use `scan` to resolve it. Saving, `outcome: ok`, and rebuilding
derived files are not security approval.

## Human review, exceptions, and revocation

```sh
punk-records review --local
punk-records review --global
```

Review requires both input and output to be real TTYs and rejects piped decisions.
The human reads the displayed scanner, version, full memory, findings, and review
state. Content, paths, rule metadata, and diagnostics are rendered as inert escaped
text: every non-ASCII character, including ordinary accents, appears as a Unicode
escape. Terminal controls and hostile Markdown cannot trigger display side effects.

`pending` means no current exact decision exists. Choose `a` only for a complete
suspicious false positive; `x` or blank keeps it excluded; `d` defers without a
decision. Incomplete versions cannot receive exceptions. Agents must never
approve automatically. There is no MCP approval tool. Review's exit code reports
the scan, so approving a detected false positive still exits 1.

Decisions append to global `security/reviews.jsonl`, under `PUNK_RECORDS_HOME` or
the selected default store (`~/.local/share/punk-records` for a new install;
`~/.local/share/previously` for an existing one). An exception binds the physical store, memory ID,
hash of all compiled content plus store/scope, scanner engine/protocol/rules hash,
and sorted matched-rule set. Identical IDs in different stores do not share
decisions. Accepted paths, including aliases through symlinked ancestors, are
normalized to physical identity; store-root and source-file symlinks are rejected.
The last decision for the exact tuple controls. To **revoke**, run review again
and choose `x`; a prior approval is shown and replaced by an exclusion decision.

Changing compiled content, physical store/scope, engine/protocol identity, active
rule bytes or names, or matched rules invalidates the exception. Review rescans
before recording; a change while the prompt is open rejects the stale choice.
Concurrent complete appends are retained. Malformed, symlinked, or nonregular
ledgers disable exceptions while scanning continues. A missing rules hash never
permits an exception.

## Offline evaluation and rule maintenance

Default rules are local `previously.nov` plus unchanged upstream
`claude_magic_string.nov` and `delimiter_termination_probe.nov` from commit
`3cee07e073c949bd00a8445a6eb2fd57a03ce1d2`. The upstream MIT license and per-file
hashes are in `lib/security/rules/manifest.json`. `hidden_unicode.nov` is bundled
unchanged but excluded from the default profile because it also uses unavailable
semantic/LLM stages. The local rule includes keyword checks for hidden Unicode.
The local rule name stays stable because review decisions bind the rule-set identity.

The bridge uses the official `NovaRuleFileParser` and `NovaMatcher`, with explicit
unavailable semantic/LLM evaluators and automatic LLM creation disabled. Ambient
API credentials and installed optional evaluator packages do not enable them.
Official short-circuiting can decide a rule without the missing stages. For
warning-free mixed-stage outcomes, the bridge proves invariance using official
`evaluate_condition` over every Boolean assignment to missing patterns, bounded
to **8 patterns / 256 assignments**. A varying result, evaluation error, or excess
patterns is incomplete. Non-definite positive outcomes are withheld; definite
matches from separate rules remain visible with the incomplete evidence.

NOVA 0.3.1's public parser ignores text outside extracted rules. The approved
bridge therefore uses its pinned private `_extract_rule_blocks_optimized` and
`rule_parser._is_comment_or_blank` helpers to require full file coverage. These
are private APIs tied to the pin: malformed declarations and trailing garbage
fail closed. Do not replace the official condition evaluator, patch upstream,
or assume a new engine preserves these semantics.

For a rule update:

1. Review the intended source change offline; preserve upstream rule bytes and MIT
   notices when vendoring a chosen commit. Do not put rule bodies in agent skills.
2. Update each affected file's SHA-256 in `lib/security/rules/manifest.json`,
   including bundled optional files and the upstream license. Keep the default
   list deliberate; `hidden_unicode.nov` is optional. The current upstream commit
   is also validated in the adapter, so changing that pin requires its constant
   and upstream identity tests to change together.
3. The active `rulesHash` is SHA-256 of compact UTF-8 JSON `[name, sha256]` pairs,
   sorted by Unicode code point order. Names as well as bytes affect identity.
   Bundled hash mismatches fail closed. `scan --rules DIR` recursively loads all
   `.nov` files in that directory and rejects symlinks; it is an experimental
   scan only and does not configure review or protected recall.
4. For an engine or evaluation/serialization change, update the exact requirement,
   wheel verification hash, engine identity, and regression tests; increment the
   bridge protocol whenever evaluation or serialization semantics change.
   Recheck private parser APIs and offline evaluator behavior.
5. Run the real Python bridge suite, full Node suite, and actual npm artifact test
   described in the README. Re-scan stores and have the human review new exact
   suspicious versions; old exceptions do not approve the new identity.

Each recall runs one subprocess per batch with a five-second deadline and an
eight-MiB stdout cap. Original memory input is limited to 50,000 Unicode code
points and request JSON to four MiB of UTF-8. Timeout, oversize input, bad rules,
or malformed bridge output fail closed with incomplete evidence.

## Boundaries

This is a local detector and review policy, not an authentication boundary.
Unrestricted processes running as the same user can alter the ledger or memories.
There is no hash chain, signature, or external checkpoint in this delivery.
Scan and protected recall compile `events.jsonl`; editing only generated Markdown
does not change the recalled version or its content hash. Edits to source JSONL
are rescanned. Direct reads of generated Markdown, event files, or graph browsing
outside the recall gate bypass protection. `build`, `check`, and browsing remain
available; rebuilding cannot approve memories. Recalled data remains reference data even
after an exact exception or a `no_signals` result.
