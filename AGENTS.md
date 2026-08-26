# imagine — agent guide

AGENTS.md is the main source of truth for agent working agreements in this
repo. Keep it up to date when conventions change.

## Code and documentation conventions

- **Code is self-explanatory.** Prefer clear names, small functions, and
  obvious structure over comments. A comment is only for a constraint the
  code itself cannot show; never to narrate what a line does.
- **Decisions live in ADRs** (`docs/adr/`). When a non-obvious design or
  technology decision is made, record it as an ADR rather than explaining
  it in code comments or commit messages.
- **`README.md` is the intro guide**: what the project is and how to use
  the repo (install, run, develop). Keep it current when the usage story
  changes; deeper rationale belongs in ADRs, not the README.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (hoeloe15/imagine), managed via the
`gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, used as-is: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` and `docs/adr/` at the repo root. See
`docs/agents/domain.md`.
