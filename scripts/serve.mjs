#!/usr/bin/env node
// Mini-serveur local, sans dépendance, lié à 127.0.0.1 uniquement.
// Sert l'application et enregistre le carnet de chaque profil dans data/ (sauvegardes datées).
// Profils : data/profils.json ({ profils: [{ id, nom, fichier? }] }) ; fichier par défaut carnet-<id>.json.
// Usage : node scripts/serve.mjs [--port 8765] [--open]
import http from "node:http";
import { readFile, writeFile, rename, mkdir, readdir, unlink, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import path from "node:path";
import { refresh, yahoo } from "./refresh-market.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const BACKUPS = path.join(DATA, "backups");
const HOST = "127.0.0.1";
const argPort = process.argv.indexOf("--port");
const PORT = argPort > 0 ? +process.argv[argPort + 1] : 8765;
const GARDER_SAUVEGARDES = 60;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
// Seuls ces chemins sont servis : jamais source/ ni scripts/.
const PUBLIC = [/^\/index\.html$/, /^\/(js|css|vendor)\/[\w.-]+$/, /^\/data\/(market|instruments)\.(json|js)$/, /^\/data\/carnets\.js$/, /^\/favicon\.svg$/];

const STORES = {
  carnet: { check: (o) => Array.isArray(o.transactions) },
  instruments: { file: "instruments.json", js: "PEA_INSTRUMENTS", check: (o) => Array.isArray(o.instruments) },
};
const PROFIL_DEFAUT = { id: "nicolas", nom: "Nicolas", fichier: "carnet.json" };

async function readProfils() {
  let list;
  try { list = JSON.parse(await readFile(path.join(DATA, "profils.json"), "utf8")).profils; } catch { list = null; }
  return (Array.isArray(list) && list.length ? list : [PROFIL_DEFAUT])
    .filter((p) => /^[a-z0-9-]{1,32}$/.test(p.id))
    .map((p) => ({ id: p.id, nom: p.nom || p.id, fichier: /^carnet[\w-]*\.json$/.test(p.fichier || "") ? p.fichier : `carnet-${p.id}.json` }));
}
async function profilDe(url) {
  const profils = await readProfils();
  const id = url.searchParams.get("profil");
  return id ? profils.find((p) => p.id === id) : profils[0];
}

/** data/carnets.js : tous les carnets, pour l'ouverture en double-clic (file://), où l'on ne peut pas lire de JSON. */
async function writeCarnetsJS() {
  const profils = await readProfils();
  const carnets = {};
  for (const p of profils) {
    try { carnets[p.id] = JSON.parse(await readFile(path.join(DATA, p.fichier), "utf8")); } catch { /* carnet pas encore créé */ }
  }
  const pub = profils.map(({ id, nom }) => ({ id, nom }));
  await writeFile(path.join(DATA, "carnets.js"), `window.PEA_PROFILS = ${JSON.stringify(pub)};\nwindow.PEA_CARNETS = ${JSON.stringify(carnets, null, 1)};\n`);
}

let refreshing = null;
let lastRefresh = 0;

async function save(store, obj, profil) {
  const s = STORES[store];
  const fichier = store === "carnet" ? profil.fichier : s.file;
  const file = path.join(DATA, fichier);
  const prefix = fichier.replace(".json", "");
  await mkdir(BACKUPS, { recursive: true });
  // Sauvegarde automatique datée de la version précédente (une par jour et par type, la plus récente gagne)
  try {
    const prev = await readFile(file);
    const day = new Date().toISOString().slice(0, 10);
    await writeFile(path.join(BACKUPS, `${prefix}-${day}.json`), prev);
    const all = (await readdir(BACKUPS)).filter((f) => new RegExp(`^${prefix}-\\d{4}-`).test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - GARDER_SAUVEGARDES))) await unlink(path.join(BACKUPS, f));
  } catch { /* premier enregistrement */ }
  const text = JSON.stringify(obj, null, 1);
  await writeFile(file + ".tmp", text);
  await rename(file + ".tmp", file);
  if (store === "carnet") await writeCarnetsJS();
  else await writeFile(path.join(DATA, s.file.replace(".json", ".js")), `window.${s.js} = ${text};\n`);
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5e6) throw new Error("trop volumineux");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (req, res) => {
  try {
    // Protection basique : refuser les requêtes venant d'une autre origine (une page web tierce ouverte dans le navigateur)
    const origin = req.headers.origin;
    if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) return send(res, 403, { error: "origine refusée" });
    const url = new URL(req.url, `http://${HOST}`);
    const p = decodeURIComponent(url.pathname);

    if (p === "/api/status") return send(res, 200, { ok: true, refreshing: !!refreshing, lastRefresh });

    if (p === "/api/profils") return send(res, 200, { profils: (await readProfils()).map(({ id, nom }) => ({ id, nom })) });

    const m = p.match(/^\/api\/(carnet|instruments)$/);
    if (m) {
      const profil = m[1] === "carnet" ? await profilDe(url) : null;
      if (m[1] === "carnet" && !profil) return send(res, 404, { error: "profil inconnu" });
      const fichier = profil ? profil.fichier : STORES[m[1]].file;
      if (req.method === "GET") {
        try { return send(res, 200, await readFile(path.join(DATA, fichier))); } catch { return send(res, 404, { error: "absent" }); }
      }
      if (req.method === "PUT") {
        const o = await body(req);
        if (!STORES[m[1]].check(o)) return send(res, 400, { error: "format invalide" });
        await save(m[1], o, profil);
        return send(res, 200, { ok: true, updatedAt: o.updatedAt });
      }
      return send(res, 405, { error: "méthode" });
    }

    if (p === "/api/refresh" && req.method === "POST") {
      // Les cours ne bougent pas plus vite que ça : au plus un rafraîchissement par minute.
      if (!refreshing && Date.now() - lastRefresh > 60000) {
        refreshing = refresh({ log: (s) => console.log("[cours]", s) }).finally(() => { lastRefresh = Date.now(); refreshing = null; });
      }
      if (refreshing) await refreshing;
      return send(res, 200, await readFile(path.join(DATA, "market.json")));
    }

    if (p === "/api/resolve" && req.method === "GET") {
      // Recherche publique d'un instrument (nom ou ISIN) pour l'ajouter au référentiel.
      const q = (url.searchParams.get("q") || "").slice(0, 80);
      if (!q) return send(res, 400, { error: "q manquant" });
      return send(res, 200, await yahoo.search(q));
    }

    if (req.method !== "GET") return send(res, 405, { error: "méthode" });
    const rel = p === "/" ? "/index.html" : p;
    if (!PUBLIC.some((r) => r.test(rel))) return send(res, 404, "Introuvable", "text/plain; charset=utf-8");
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) return send(res, 403, "Interdit", "text/plain");
    await stat(file);
    return send(res, 200, await readFile(file), TYPES[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    if (e.code === "ENOENT") return send(res, 404, "Introuvable", "text/plain; charset=utf-8");
    console.error(e);
    return send(res, 500, { error: e.message });
  }
});

await writeCarnetsJS().catch((e) => console.error("carnets.js :", e.message));
server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`Suivi PEA : ${url}  (Ctrl+C pour arrêter)`);
  if (process.argv.includes("--open")) openBrowser(url);
});

function openBrowser(url) {
  // WSL : ouvrir le navigateur Windows ; sinon xdg-open / open
  const cmd = process.env.WSL_DISTRO_NAME ? `cmd.exe /c start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, { cwd: "/" }, () => {});
}
