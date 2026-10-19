#!/usr/bin/env sh
# Démarre le serveur local (127.0.0.1 uniquement) et ouvre l'application dans le navigateur.
cd "$(dirname "$0")" && exec node scripts/serve.mjs --open "$@"
