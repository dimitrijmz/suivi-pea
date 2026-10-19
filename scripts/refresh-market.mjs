#!/usr/bin/env node
// Rafraîchit les données de marché publiques -> data/market.json (+ data/market.js pour le mode double-clic).
// Ne lit QUE la liste des tickers (data/instruments.json) : aucune quantité ni montant n'est lu ni envoyé.
// En cas d'échec d'une source, on conserve la dernière valeur connue avec sa date : rien n'est inventé.
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as yahoo from "./providers/yahoo.mjs";

const require = createRequire(import.meta.url);
const Engine = require("../js/engine.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");

const PROVIDERS = [yahoo]; // ajouter ici une source de repli exposant la même interface
const DEBUT_HISTORIQUE = "2021-01-01"; // dividendes : 3 ans d'historique au moins pour les estimations

async function readJSON(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

async function fetchTicker(ticker, histFrom) {
  let lastErr;
  for (const p of PROVIDERS) {
    try {
      const { history, quote } = await p.getHistory(ticker, DEBUT_HISTORIQUE);
      const { dividends, splits } = await p.getDividends(ticker, DEBUT_HISTORIQUE);
      let nextExDate = null;
      try { nextExDate = await p.getNextExDate(ticker); } catch { /* facultatif */ }
      // Retour aux montants réellement versés / cours réellement cotés (annule l'ajustement des attributions gratuites)
      const raw = Engine.unadjustCloses(history, splits).filter(([d]) => d >= histFrom);
      // Titres peu liquides (ex. PERR.PA) : Yahoo peut figer le « dernier cours » alors que l'historique avance.
      // On garde alors la clôture la plus récente de l'historique, avec sa propre date.
      const last = raw[raw.length - 1];
      if (last && last[0] > quote.priceTime.slice(0, 10)) {
        quote.price = last[1];
        quote.priceTime = `${last[0]}T15:30:00.000Z`; // clôture Euronext (17h30 Paris)
      }
      const priceDay = quote.priceTime.slice(0, 10);
      const prev = [...raw].reverse().find(([d]) => d < priceDay);
      const previousClose = prev ? prev[1] : null;
      return {
        source: p.name, name: quote.name, currency: quote.currency, price: quote.price, priceTime: quote.priceTime,
        previousClose, change: previousClose ? round(quote.price - previousClose, 4) : null,
        changePct: previousClose ? quote.price / previousClose - 1 : null,
        history: raw, splits, dividends: Engine.unadjustDividends(dividends, splits), nextExDate,
        updatedAt: new Date().toISOString(), error: null,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;

export async function refresh({ log = console.log } = {}) {
  const ref = await readJSON(path.join(DATA, "instruments.json"), { instruments: [] });
  const previous = await readJSON(path.join(DATA, "market.json"), { tickers: {} });
  const tickers = ref.instruments.map((i) => i.ticker).filter(Boolean);
  // Début de l'historique de cours : date fixe, indépendante du carnet (aucune donnée privée lue ici).
  const histFrom = "2024-01-01";
  const out = { generatedAt: new Date().toISOString(), sources: PROVIDERS.map((p) => p.name), tickers: {} };
  let ok = 0;
  const results = [];
  for (const tk of tickers) { // séquentiel : Yahoo répond 429 aux rafales
    try { results.push([tk, await fetchTicker(tk, histFrom)]); } catch (e) { results.push([tk, e]); }
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const [tk, r] of results) {
    if (r instanceof Error) {
      const old = previous.tickers[tk];
      out.tickers[tk] = old && typeof old.price === "number" ? { ...old, error: `Source injoignable (${r.message}) — dernière valeur du ${old.updatedAt}` }
        : { error: `Source injoignable (${r.message})`, history: [], dividends: [], splits: [] };
      log(`✗ ${tk} : ${r.message}`);
    } else {
      out.tickers[tk] = r;
      ok++;
    }
  }
  out.ok = ok;
  out.total = tickers.length;
  await mkdir(DATA, { recursive: true });
  const text = JSON.stringify(out);
  await writeFile(path.join(DATA, "market.json.tmp"), text);
  await rename(path.join(DATA, "market.json.tmp"), path.join(DATA, "market.json"));
  await writeFile(path.join(DATA, "market.js"), `window.PEA_MARKET = ${text};\n`);
  log(`${ok}/${tickers.length} tickers à jour — ${new Date().toLocaleString("fr-FR")}`);
  return out;
}

export { yahoo };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  refresh().then((o) => process.exit(o.ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
}
