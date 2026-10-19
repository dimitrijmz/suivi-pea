#!/usr/bin/env bash
# Lancé par la tâche planifiée : rafraîchit les cours et journalise dans data/refresh.log.
cd "$(dirname "$0")/.." || exit 1
mkdir -p data
echo "--- $(date '+%d/%m/%Y %H:%M')" >> data/refresh.log
# La tâche planifiée n'a pas le PATH du terminal : on cherche aussi Node installé via nvm.
NODE="$(command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
exec "${NODE:-node}" scripts/refresh-market.mjs >> data/refresh.log 2>&1
