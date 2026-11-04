# Reconcile an existing installation

Run the helper from a local checkout after upgrading to the rebrand. It uses the
existing `init` migrations; it does not delete memory stores, remove the old
executable alias, approve security findings or approve Codex hooks.

## Preview first

```sh
node scripts/reconcile-installation.mjs --source /path/to/stable/checkout --registered
```

The default is read-only. `--source` selects the stable checkout whose CLI and
executables will be used; avoid pointing a lasting installation at a temporary
worktree. The helper defaults to Claude Code and Codex. `--registered` opts into
projects listed in the memory-store registry that already have Punk Records
configuration. Memory-only projects do not receive new local hooks. Missing
projects are reported rather than silently treated as migrated.

You can explicitly include a repository or linked worktree, even if it is absent
from the registry:

```sh
node scripts/reconcile-installation.mjs --source /path/to/stable/checkout --repo "/path/with spaces/project"
```

The helper checks inherited `PREVIOUSLY_*` variables, supported shell profile
assignments and executable ownership, then runs `init --dry-run` for all selected
scopes before applying any changes. It preserves variable values and refuses
conflicts rather than evaluating arbitrary shell code. Custom shell constructs
may require manual edits.

By default, child `init` output is withheld because it can contain configuration
values. Add `--details` to inspect it locally, including migration plans and warnings;
avoid sharing that raw output without checking it. Apply saves full init diagnostics
in the private backup directory. Review them for any remaining manual work.

## Apply

Close active agent sessions and viewer processes first. Review the preview and
resolve any reported conflicts, then repeat the same selection with `--apply`:

```sh
node scripts/reconcile-installation.mjs --source /path/to/stable/checkout --registered --apply
```

The helper backs up changed shell profiles, updates owned canonical executable
links, and invokes the global and selected local `init` migrations. Those
migrations preserve foreign entries and back up changed configuration files.
SQLite sidecars and conflicting stores require manual reconciliation; the helper
does not checkpoint databases or terminate other processes. Custom managed MCP
blocks with unsupported syntax can also block store relocation: inspect the indicated
block before rerunning the preview; do not bypass the preflight. Managed Codex
blocks support reordered invocation keys and preserve per-tool settings such as
`approval_mode`; those settings do not need to be removed for migration.

This is not a transaction across repositories. If a later operation fails, earlier
completed operations may remain applied; inspect its report and backups, resolve
the error, and rerun. Do not blindly restore a pre-migration configuration after
its referenced store has moved.

Open a new login/shell session afterward: a child process cannot change the
environment of its parent shell or already-running agents. In Codex, use `/hooks`
to approve changed hook commands when requested. Review affected security findings
again: old rule identities and hashes do not authorize the renamed rules.

Keep the old executable alias until unregistered projects and custom launchers
have also migrated. The registry is not an exhaustive inventory of the device.
