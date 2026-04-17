#!/bin/bash
# Purge .env from entire Git history (run once from repo root).
# After running: force-push to GitHub, then consider rotating any secrets that were ever in .env.

set -e
cd "$(git rev-parse --show-toplevel)"

echo "This will rewrite history and remove .env from every commit."
echo "You will need to run: git push --force"
read -p "Continue? (y/N) " -n 1 -r
echo
[[ $REPLY =~ ^[yY]$ ]] || exit 1

git filter-branch --force --index-filter 'git rm --cached --ignore-unmatch .env' --prune-empty --tag-name-filter cat -- --all

echo "Done. Run: git push --force"
echo "Then rotate any secrets that were ever in .env (tokens, passwords)."
