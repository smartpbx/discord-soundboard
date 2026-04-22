# Repo conventions for Claude / Claude Code

## Always update CHANGELOG.md on user-visible commits

Every commit that ships a user-visible change must also add an entry to
`CHANGELOG.md` at the repo root. The web UI surfaces this through a
"What's New" modal, and the version badge in the footer shows the short
git SHA. If the changelog lags behind, the UI will claim nothing shipped.

**Format** (newest entry at top, under the running heading):

```
## <YYYY-MM-DD> — <shortSHA>
- <user-facing bullet, not commit-speak>
- <another bullet if applicable>
```

Purely internal commits (comment fixes, dependency bumps without behavior
change) can skip the changelog, but when in doubt, add it.

## Version badge / cache refresh

`GET /api/version` returns `{ sha, shortSha, packageVersion, buildTime }`
read from `git rev-parse HEAD` at server startup. The frontend polls
this and compares with the SHA it was loaded with — a mismatch renders a
banner prompting a hard refresh. No manual version bump is required.

## Deploy flow

1. Make changes locally.
2. Update `CHANGELOG.md` with the user-facing bullet(s).
3. `git add` only intended files (skip `node_modules/.package-lock.json`
   drift), commit, push.
4. On CT 109: `bash scripts/update.sh` (git pull + npm install + service
   restart).

Never skip commit hooks (`--no-verify`). If a hook fails, fix the root
cause.
