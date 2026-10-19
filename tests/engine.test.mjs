// Tests du moteur de calcul : node --test tests/
// 1) Tests synthétiques (données fictives) : un test par défaut connu de l'Excel corrigé (CLAUDE.md §4).
// 2) Non-régression contre le classeur réel, si data/ est présent (données privées, jamais committées).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const E = require("../js/engine.js");
const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b} (±${eps})`);

const I = [
  { ticker: "AAA.PA", nom: "Alpha", isin: "FR0000000001", retenueSource: 0 },
  { ticker: "BBB.PA", nom: "Beta", isin: "FR0000000002", retenueSource: 0 },
  { ticker: "ETF.PA", nom: "ETF Cap", isin: "FR0000000003", distribution: "capitalisant", retenueSource: 0 },
];
let n = 0;
const tx = (type, ticker, quantite, date, prix) => ({ id: `t${++n}`, type, ticker, quantite, date, prix, montant: E.round2(quantite * prix) });
const apport = (date, m) => ({ id: `t${++n}`, type: "Apport", libelle: "Perso", quantite: 1, date, prix: m, montant: m });

test("PRU au coût moyen pondéré, frais inclus", () => {
  const l = E.computeLedger([tx("Achat", "AAA.PA", 10, "2024-01-02", 10), tx("Achat", "AAA.PA", 10, "2024-02-01", 20)]).lines.get("AAA.PA");
  assert.equal(l.quantite, 20);
  close(l.pru, 15);
});

test("§4 — les ventes sortent les parts du portefeuille et ne modifient pas le PRU restant", () => {
  const t = [tx("Achat", "AAA.PA", 10, "2024-01-02", 10), tx("Achat", "AAA.PA", 10, "2024-02-01", 20), tx("Vente", "AAA.PA", 5, "2024-03-01", 30)];
  const l = E.computeLedger(t).lines.get("AAA.PA");
  assert.equal(l.quantite, 15);
  close(l.pru, 15);
  close(l.realise, 5 * (30 - 15)); // plus-value réalisée = q × (prix de vente − PRU)
});

test("§4 — une ligne entièrement vendue passe dans les lignes soldées avec sa plus-value réalisée", () => {
  const t = [apport("2024-01-01", 1000), tx("Achat", "BBB.PA", 4, "2024-01-02", 50), tx("Vente", "BBB.PA", 4, "2024-06-01", 40)];
  const p = E.computePortfolio(t, { tickers: { "BBB.PA": { price: 45, history: [] } } }, I, { today: "2024-07-01" });
  assert.equal(p.lignes.length, 0);
  assert.equal(p.soldees.length, 1);
  close(p.soldees[0].realise, -40);
  close(p.totaux.cash, 1000 - 200 + 160);
});

test("§4 — la valeur du portefeuille agrège toutes les lignes (aucune omise)", () => {
  const t = [tx("Achat", "AAA.PA", 2, "2024-01-02", 10), tx("Achat", "BBB.PA", 3, "2024-01-02", 10), tx("Achat", "ETF.PA", 1, "2024-01-02", 10)];
  const mk = { tickers: { "AAA.PA": { price: 11 }, "BBB.PA": { price: 12 }, "ETF.PA": { price: 13 } } };
  const p = E.computePortfolio(t, mk, I, { today: "2024-02-01" });
  close(p.totaux.valeurTitres, 2 * 11 + 3 * 12 + 13);
  close(p.totaux.plusValueLatente, 2 + 6 + 3);
});

test("§4 — position calculée par date, indépendamment de l'ordre de saisie", () => {
  const t = [tx("Achat", "AAA.PA", 5, "2024-03-01", 10), tx("Achat", "AAA.PA", 3, "2024-01-01", 10), tx("Vente", "AAA.PA", 2, "2024-02-01", 10)];
  assert.equal(E.positionAt(t, "AAA.PA", "2024-02-15"), 1);
  assert.equal(E.positionAt(t, "AAA.PA", "2024-03-01"), 6);
  assert.equal(E.positionAt(t, "AAA.PA", "2024-03-01", true), 1); // veille du détachement
});

test("§4 — les cours texte « 170,44 » ne sont plus un problème : le moteur ne reçoit que des nombres", () => {
  const p = E.computePortfolio([tx("Achat", "AAA.PA", 1, "2024-01-02", 100)], { tickers: { "AAA.PA": { price: 170.44 } } }, I, { today: "2024-02-01" });
  close(p.lignes[0].valeur, 170.44);
});

test("§4 — années de dividendes générées dynamiquement (2027 et au-delà)", () => {
  const t = [tx("Achat", "AAA.PA", 10, "2026-01-02", 10)];
  const mk = { tickers: { "AAA.PA": { price: 10, dividends: [{ exDate: "2026-05-04", montant: 1 }, { exDate: "2027-05-04", montant: 1.1 }, { exDate: "2028-05-04", montant: 1.2 }] } } };
  const d = E.computeDividends(t, mk, I, "2028-12-31");
  assert.deepEqual(d.aggregate.years, ["2026", "2027", "2028"]);
  close(d.aggregate.byYear["2028"], 12);
});

test("Dividende perçu = parts détenues la veille du détachement × montant brut", () => {
  const t = [tx("Achat", "AAA.PA", 10, "2024-01-02", 10), tx("Achat", "AAA.PA", 5, "2024-05-02", 10)];
  const mk = { tickers: { "AAA.PA": { dividends: [{ exDate: "2024-05-02", montant: 2 }] } } };
  const d = E.computeDividends(t, mk, I, "2024-12-31");
  assert.equal(d.records.length, 1);
  assert.equal(d.records[0].parts, 10); // l'achat du jour du détachement n'y a pas droit
  close(d.records[0].montant, 20);
  assert.equal(d.records[0].source, "calculé");
});

test("Rapprochement : la saisie manuelle fait foi, l'écart > 1 € est expliqué, le décalage est calibré", () => {
  const t = [tx("Achat", "AAA.PA", 10, "2024-01-02", 10), tx("Dividende", "AAA.PA", 9, "2024-05-07", 2)];
  const mk = { tickers: { "AAA.PA": { dividends: [{ exDate: "2024-05-02", montant: 2 }, { exDate: "2024-11-04", montant: 2 }] } } };
  const d = E.computeDividends(t, mk, I, "2024-12-31");
  const r = d.records.find((x) => x.source === "rapproché");
  close(r.montant, 18);
  close(r.ecart, -2);
  assert.match(r.explication, /Parts différentes/);
  assert.equal(d.offsets["AAA.PA"], 3); // jeudi 02/05 -> mardi 07/05 = 3 jours ouvrés
  const autre = d.records.find((x) => x.exDate === "2024-11-04");
  assert.equal(autre.datePaiement, "2024-11-07");
});

test("Attribution gratuite : dividendes Yahoo dé-ajustés, saisie orpheline expliquée comme rompus", () => {
  const splits = [{ date: "2024-06-10", num: 11, den: 10 }];
  const raw = E.unadjustDividends([{ exDate: "2024-05-20", montant: 2.909091 }], splits);
  close(raw[0].montant, 3.2, 1e-5);
  const t = [tx("Achat", "AAA.PA", 7, "2024-01-02", 150), tx("Dividende", "AAA.PA", 1, "2024-07-11", 114.68)];
  const d = E.computeDividends(t, { tickers: { "AAA.PA": { dividends: raw, splits } } }, I, "2024-12-31");
  const orphan = d.records.find((x) => x.source === "saisi");
  assert.match(orphan.explication, /rompus/);
});

test("ETF capitalisant : aucun dividende, aucune erreur", () => {
  const t = [tx("Achat", "ETF.PA", 3, "2024-01-02", 100)];
  const d = E.computeDividends(t, { tickers: { "ETF.PA": { dividends: [] } } }, I, "2024-12-31");
  assert.equal(d.records.length, 0);
  const f = E.forecastDividends(t, { tickers: { "ETF.PA": { dividends: [] } } }, I, { today: "2024-12-31" });
  assert.equal(f.events.length, 0);
});

test("Prochains dividendes : estimés à partir des 12 derniers mois, date annoncée = confirmée", () => {
  const t = [tx("Achat", "AAA.PA", 10, "2023-01-02", 10)];
  const mk = { tickers: { "AAA.PA": { nextExDate: "2025-04-30", dividends: [
    { exDate: "2023-05-02", montant: 1 }, { exDate: "2023-11-02", montant: 0.5 },
    { exDate: "2024-05-02", montant: 1.2 }, { exDate: "2024-11-04", montant: 0.6 }] } } };
  const f = E.forecastDividends(t, mk, I, { today: "2024-12-01" });
  assert.equal(f.events.length, 2);
  assert.equal(f.events[0].exDate, "2025-04-30");
  assert.equal(f.events[0].fiabilite, "date confirmée");
  close(f.events[0].montant, 12);
  assert.equal(f.events[1].fiabilite, "estimé");
  assert.equal(f.events[1].exDate, "2025-11-04");
});

test("Validation : quantité, date future, vente supérieure aux parts, ligne inconnue", () => {
  const t = [tx("Achat", "AAA.PA", 5, "2024-01-02", 10)];
  const v = (o) => E.validateTransaction({ id: "new", ...o }, t, I, "2024-06-01");
  assert.equal(v({ type: "Achat", ticker: "AAA.PA", quantite: 1, date: "2024-05-01", prix: 10 }).length, 0);
  assert.ok(v({ type: "Achat", ticker: "AAA.PA", quantite: 0, date: "2024-05-01", prix: 10 }).length);
  assert.ok(v({ type: "Achat", ticker: "AAA.PA", quantite: 1, date: "2024-07-01", prix: 10 }).length);
  assert.ok(v({ type: "Vente", ticker: "AAA.PA", quantite: 6, date: "2024-05-01", prix: 10 }).length);
  assert.ok(v({ type: "Vente", ticker: "AAA.PA", quantite: 1, date: "2023-12-01", prix: 10 }).length); // avant l'achat
  assert.ok(v({ type: "Achat", ticker: "ZZZ.PA", quantite: 1, date: "2024-05-01", prix: 10 }).length);
});

test("XIRR : 1000 € devenus 1100 € en un an ≈ 10 %", () => {
  close(E.xirr([{ date: "2024-01-01", montant: -1000 }, { date: "2024-12-31", montant: 1100 }]), 0.1003, 0.001);
});

// ------------------------------------------------------------------ non-régression
const DATA = new URL("../data/", import.meta.url);
const has = (f) => existsSync(new URL(f, DATA));
const load = (f) => JSON.parse(readFileSync(new URL(f, DATA), "utf8"));
const real = has("carnet.json") && has("excel-reference.json");

test("Classeur réel — mêmes parts et PRU que la feuille Portefeuille (hors lignes vendues)", { skip: !real && "data/ absent" }, () => {
  const ref = load("excel-reference.json");
  const { lines } = E.computeLedger(load("carnet.json").transactions);
  for (const r of ref.lignes) {
    const l = lines.get(r.ticker);
    assert.equal(l.quantite, r.parts, r.nom);
    close(l.pru, r.pru, 0.005);
  }
});

test("Classeur réel — même total de versements (Apport + Parrainage)", { skip: !real && "data/ absent" }, () => {
  const ref = load("excel-reference.json");
  close(E.computeLedger(load("carnet.json").transactions).versements, ref.versements);
});

test("Classeur réel — les lignes vendues (TNO, PSP5, EWLD) sont soldées", { skip: !real && "data/ absent" }, () => {
  const { lines } = E.computeLedger(load("carnet.json").transactions);
  for (const tk of ["TNO.PA", "PSP5.PA", "EWLD.PA"]) assert.equal(lines.get(tk).quantite, 0, tk);
});

test("Classeur réel — dividendes annuels identiques à la feuille Dividendes", { skip: !(real && has("market.json")) && "data/ absent" }, () => {
  const ref = load("excel-reference.json");
  const d = E.computeDividends(load("carnet.json").transactions, load("market.json"), load("instruments.json").instruments, "2026-10-15");
  for (const [y, v] of Object.entries(ref.dividendesParAnnee)) close(d.aggregate.byYear[y] || 0, v, 5);
});

// ------------------------------------------------------------ fiscalité PEA
test("PEA : jalon des 5 ans et taux de retrait (31,4 % avant, 18,6 % après)", () => {
  const a = E.anciennetePEA("2023-03-14", "2026-10-16");
  assert.equal(a.jalon, "2028-03-14");
  assert.equal(a.atteint, false);
  assert.equal(a.joursRestants, 515);
  close(E.tauxRetraitPEA("2023-03-14", "2028-03-13").taux, 0.314, 1e-9);
  close(E.tauxRetraitPEA("2023-03-14", "2028-03-14").taux, 0.186, 1e-9);
  assert.equal(E.anciennetePEA("2024-02-29", "2029-02-28").atteint, true);
});

test("Frais de courtage : minimum appliqué, sinon taux", () => {
  assert.equal(E.fraisCourtage(100, { taux: 0.005, minimum: 1.99 }), 1.99);
  assert.equal(E.fraisCourtage(10000, { taux: 0.005, minimum: 1.99 }), 50);
  assert.equal(E.fraisCourtage(0), 0);
});

test("Vente simulée : net après frais et plus-value, sans impôt", () => {
  const v = E.simulerVente({ quantite: 10, cours: 120, cout: 1000 }, { taux: 0.01, minimum: 0 });
  assert.deepEqual(v, { brut: 1200, frais: 12, net: 1188, plusValue: 188 });
  assert.equal(E.simulerVente({ quantite: 1, cours: null, cout: 10 }), null);
});

test("Retrait après 5 ans : seule la part de gain est taxée à 18,6 %", () => {
  const g = { taux: 0, minimum: 0 };
  const r = E.simulerRetraitPEA({ lignes: [{ quantite: 100, cours: 150, cout: 10000 }], cash: 0, versements: 10000,
    montant: 3000, dateOuverture: "2018-01-01", date: "2026-10-16", grille: g });
  assert.equal(r.cloture, false);
  assert.equal(r.gainPlan, 5000);
  assert.equal(r.partGain, 1000); // 3000 × 5000 / 15000
  assert.equal(r.impot, 186);
  assert.equal(r.net, 2814);
});

test("Retrait avant 5 ans : clôture, tout est retiré et taxé à 31,4 % sur le gain", () => {
  const r = E.simulerRetraitPEA({ lignes: [{ quantite: 100, cours: 150, cout: 10000 }], cash: 0, versements: 10000,
    montant: 1000, dateOuverture: "2023-03-14", date: "2026-10-16", grille: { taux: 0.01, minimum: 0 } });
  assert.equal(r.cloture, true);
  assert.equal(r.fraisVente, 150);
  assert.equal(r.montant, 14850);
  assert.equal(r.partGain, 4850);
  assert.equal(r.impot, E.round2(4850 * 0.314));
});

test("Retrait en moins-value : aucun impôt", () => {
  const r = E.simulerRetraitPEA({ lignes: [{ quantite: 10, cours: 80, cout: 1000 }], cash: 50, versements: 1050,
    dateOuverture: "2023-03-14", date: "2026-10-16", grille: { taux: 0, minimum: 0 } });
  assert.equal(r.impot, 0);
  assert.equal(r.net, 850);
});
