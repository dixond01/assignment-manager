#!/bin/sh
# macOS first-time setup (double-click in Finder): create the Assignment Manager app and a
# Desktop link to it, then open the app. Runs `node tools/setup.js`.
cd "$(dirname "$0")" || exit 1
# Finder starts this without your shell setup, so also look where Homebrew and the Node installer put node.
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install it from https://nodejs.org, then run this again."
  exit 1
fi
node tools/setup.js
