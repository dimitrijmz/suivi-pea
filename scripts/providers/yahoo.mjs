// Source Yahoo Finance (données publiques). Seul le ticker (ex. « AI.PA ») est envoyé.
// Interface commune à toutes les sources : getQuote, getHistory, getDividends, getNextExDate.
// Yahoo applique ses limites de débit (429) par couple IP + User-Agent : on en essaie plusieurs.
const AGENTS = ["Mozilla/5.0", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"];
let agent = 0;
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path, headers = {}) {
  let last;
  for (let attempt = 0; attempt < AGENTS.length * 2; attempt++) {
    for (const h of HOSTS) {
      try {
        const r = await fetch(h + path, { headers: { "User-Agent": AGENTS[agent], ...headers }, signal: AbortSignal.timeout(20000) });
        if (r.ok) return await r.json();
        last = new Error(`HTTP ${r.status}`);
        if (r.status === 404) throw last;
      } catch (e) {
        last = e;
        if (/HTTP 404/.test(e.message)) throw e;
      }
    }
    agent = (agent + 1) % AGENTS.length; // 429 : changer d'agent, puis patienter
    if (attempt >= AGENTS.length - 1) await sleep(2000 * attempt);
  }
  throw last;
}

const chartCache = new Map();
/** Un seul appel « chart » fournit cours, historique, dividendes et divisions. */
async function chart(ticker, fromISO) {
  const key = ticker + fromISO;
  if (!chartCache.has(key)) {
    const p1 = Math.floor(Date.parse(fromISO + "T00:00:00Z") / 1000);
    const p2 = Math.floor(Date.now() / 1000) + 86400;
    chartCache.set(key, getJSON(`/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d&events=div%7Csplit`)
      .then((j) => {
        const res = j.chart && j.chart.result && j.chart.result[0];
        if (!res) throw new Error((j.chart && j.chart.error && j.chart.error.description) || "réponse vide");
        return res;
      }));
  }
  return chartCache.get(key);
}

export const name = "yahoo";

export async function getQuote(ticker) {
  const res = await chart(ticker, isoDaysAgo(10));
  const m = res.meta;
  return { name: m.longName || m.shortName || ticker, currency: m.currency, price: m.regularMarketPrice,
    priceTime: new Date(m.regularMarketTime * 1000).toISOString() };
}

/** Historique journalier de clôture (ajusté des divisions par Yahoo, pas des dividendes). */
export async function getHistory(ticker, fromISO) {
  const res = await chart(ticker, fromISO);
  const close = res.indicators.quote[0].close || [];
  const out = [];
  (res.timestamp || []).forEach((t, k) => {
    if (close[k] != null) out.push([iso(t + (res.meta.gmtoffset || 0)), Math.round(close[k] * 10000) / 10000]);
  });
  const m = res.meta;
  return { history: out, quote: { name: m.longName || m.shortName || ticker, currency: m.currency,
    price: m.regularMarketPrice, priceTime: new Date(m.regularMarketTime * 1000).toISOString() } };
}

/** Dividendes (montants ajustés des divisions par Yahoo) et divisions/attributions gratuites. */
export async function getDividends(ticker, fromISO) {
  const res = await chart(ticker, fromISO);
  const ev = res.events || {};
  const dividends = Object.values(ev.dividends || {})
    .map((d) => ({ exDate: iso(d.date + (res.meta.gmtoffset || 0)), montant: d.amount }))
    .sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
  const splits = Object.values(ev.splits || {})
    .map((s) => ({ date: iso(s.date + (res.meta.gmtoffset || 0)), num: s.numerator, den: s.denominator }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { dividends, splits };
}

let session;
/** Prochaine date de détachement annoncée (module calendarEvents, nécessite un « crumb » public). */
export async function getNextExDate(ticker) {
  if (!session) {
    session = (async () => {
      const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": AGENTS[agent] }, redirect: "manual", signal: AbortSignal.timeout(15000) });
      const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
      const c = await fetch(HOSTS[1] + "/v1/test/getcrumb", { headers: { "User-Agent": AGENTS[agent], Cookie: cookie }, signal: AbortSignal.timeout(15000) });
      if (!c.ok) throw new Error("crumb indisponible");
      return { cookie, crumb: await c.text() };
    })();
  }
  const { cookie, crumb } = await session;
  const j = await getJSON(`/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents&crumb=${encodeURIComponent(crumb)}`,
    { Cookie: cookie });
  const ex = j.quoteSummary?.result?.[0]?.calendarEvents?.exDividendDate?.raw;
  return ex ? iso(ex) : null;
}

/** Recherche publique par nom ou ISIN -> tickers candidats (utilisé pour ajouter une ligne au référentiel). */
export async function search(q) {
  const j = await getJSON(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`);
  return (j.quotes || []).filter((x) => x.symbol).map((x) => ({ ticker: x.symbol, nom: x.longname || x.shortname,
    place: x.exchDisp || x.exchange, type: x.quoteType }));
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}
