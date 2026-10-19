/*
 * Moteur de calcul du suivi PEA — module pur, sans DOM ni réseau.
 * Chargé tel quel par index.html (window.PEAEngine) et par Node (require) pour les tests
 * et le script de rafraîchissement. Script classique (pas d'ES module) pour que la page
 * fonctionne aussi ouverte en double-clic (file://).
 *
 * Conventions : dates « AAAA-MM-JJ » (comparables comme chaînes), montants en euros.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PEAEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PLAFOND_PEA = 150000;
  const DECALAGE_VERSEMENT_DEFAUT = 2; // jours ouvrés entre détachement et crédit, si rien à calibrer
  const FENETRE_RAPPROCHEMENT = 45; // jours max entre détachement et crédit saisi
  const TOLERANCE_ANTERIORITE = 10; // crédit saisi jusqu'à 10 jours AVANT la date de détachement de la source

  const TYPES_FLUX = ["Apport", "Parrainage"];
  const TYPES = ["Achat", "Vente", "Apport", "Parrainage", "Dividende"];

  // ---------------------------------------------------------------- dates
  const toUTC = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const fromUTC = (t) => new Date(t).toISOString().slice(0, 10);
  const addDays = (s, n) => fromUTC(toUTC(s) + n * 86400000);
  const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
  const isWeekend = (s) => {
    const d = new Date(toUTC(s)).getUTCDay();
    return d === 0 || d === 6;
  };
  function addBusinessDays(s, n) {
    let d = s;
    let left = n;
    while (left > 0) {
      d = addDays(d, 1);
      if (!isWeekend(d)) left--;
    }
    while (isWeekend(d)) d = addDays(d, 1);
    return d;
  }
  function businessDaysBetween(a, b) {
    if (b < a) return -businessDaysBetween(b, a);
    let n = 0;
    for (let d = a; d < b; d = addDays(d, 1)) if (!isWeekend(addDays(d, 1))) n++;
    return n;
  }
  function addYears(s, n) {
    const y = +s.slice(0, 4) + n;
    const md = s.slice(5);
    return md === "02-29" ? `${y}-02-28` : `${y}-${md}`;
  }
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const sum = (arr, f = (x) => x) => arr.reduce((s, x) => s + f(x), 0);
  function median(arr) {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  // ------------------------------------------------------------- carnet
  /** Tri chronologique stable : date puis ordre de saisie (jamais la position dans un tableau affiché). */
  function sortTransactions(txs) {
    return txs
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : a.i - b.i))
      .map((x) => x.t);
  }

  const montant = (t) => (typeof t.montant === "number" ? t.montant : round2(t.quantite * t.prix));

  /** Parts détenues pour un ticker. strict=true : ordres datés strictement avant `date` (veille du détachement). */
  function positionAt(txs, ticker, date, strict = false) {
    let q = 0;
    for (const t of txs) {
      if (t.ticker !== ticker) continue;
      if (strict ? t.date >= date : t.date > date) continue;
      if (t.type === "Achat") q += t.quantite;
      else if (t.type === "Vente") q -= t.quantite;
    }
    return round6(q);
  }
  const round6 = (x) => Math.round(x * 1e6) / 1e6;

  /**
   * Positions, PRU (coût moyen pondéré, frais inclus) et plus-values réalisées.
   * Une vente ne modifie pas le PRU des parts restantes.
   */
  function computeLedger(txs, asOf) {
    const lines = new Map();
    const issues = [];
    let versements = 0, achats = 0, ventes = 0, dividendesSaisis = 0;
    const line = (tk) => {
      if (!lines.has(tk))
        lines.set(tk, { ticker: tk, quantite: 0, cout: 0, pru: 0, realise: 0, investiTotal: 0,
          ventes: [], achats: 0, premiereDate: null, derniereDate: null, dividendesSaisis: 0 });
      return lines.get(tk);
    };
    for (const t of sortTransactions(txs)) {
      if (asOf && t.date > asOf) continue;
      const m = montant(t);
      if (TYPES_FLUX.includes(t.type)) { versements += m; continue; }
      if (!t.ticker) continue;
      const l = line(t.ticker);
      l.premiereDate = l.premiereDate || t.date;
      l.derniereDate = t.date;
      if (t.type === "Achat") {
        l.quantite = round6(l.quantite + t.quantite);
        l.cout += m;
        l.investiTotal += m;
        l.achats++;
        l.pru = l.quantite > 0 ? l.cout / l.quantite : 0;
        achats += m;
      } else if (t.type === "Vente") {
        if (t.quantite > l.quantite + 1e-9)
          issues.push({ id: t.id, message: `Vente de ${t.quantite} parts alors que ${l.quantite} sont détenues` });
        const q = Math.min(t.quantite, l.quantite);
        const pru = l.pru;
        const pv = m - q * pru;
        l.realise += pv;
        l.ventes.push({ id: t.id, date: t.date, quantite: t.quantite, prix: t.prix, montant: m, pru, plusValue: pv });
        l.cout -= q * pru;
        l.quantite = round6(l.quantite - t.quantite);
        if (l.quantite <= 1e-9) { l.quantite = 0; l.cout = 0; }
        ventes += m;
      } else if (t.type === "Dividende") {
        l.dividendesSaisis += m;
        dividendesSaisis += m;
      }
    }
    for (const l of lines.values()) {
      l.cout = round6(l.cout);
      l.pru = l.quantite > 0 ? l.cout / l.quantite : 0;
    }
    return { lines, issues, versements: round2(versements), achats: round2(achats),
      ventes: round2(ventes), dividendesSaisis: round2(dividendesSaisis) };
  }

  /** Vérifie un ordre avant ajout/modification. Retourne une liste de messages (vide = valide). */
  function validateTransaction(tx, others, instruments, today = todayISO()) {
    const errs = [];
    if (!TYPES.includes(tx.type)) errs.push("Type d'ordre inconnu.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date || "")) errs.push("Date invalide.");
    else if (tx.date > today) errs.push("La date ne peut pas être dans le futur.");
    if (!(tx.quantite > 0)) errs.push("La quantité doit être strictement positive.");
    if (!(tx.prix >= 0) || !isFinite(tx.prix)) errs.push("Le cours (ou montant) doit être un nombre positif ou nul.");
    if (TYPES_FLUX.includes(tx.type)) {
      if (!(tx.prix > 0)) errs.push("Le montant du versement doit être positif.");
    } else if (!tx.ticker || !instruments.some((i) => i.ticker === tx.ticker)) {
      errs.push("Ligne inconnue du référentiel : ajoutez-la d'abord.");
    } else if (tx.type === "Vente" && errs.length === 0) {
      // La vente ne doit rendre la position négative à aucune date ultérieure.
      const all = sortTransactions([...others.filter((o) => o.id !== tx.id), tx]);
      let q = 0;
      for (const t of all) {
        if (t.ticker !== tx.ticker) continue;
        if (t.type === "Achat") q += t.quantite;
        else if (t.type === "Vente") q -= t.quantite;
        if (q < -1e-9) {
          errs.push(`Vente supérieure aux parts détenues à cette date (${round6(q + t.quantite)} parts).`);
          break;
        }
      }
    }
    return errs;
  }

  // --------------------------------------------------- données de marché
  /** Facteur cumulé des divisions/attributions postérieures à `date` (ex. 11:10 -> 1,1). */
  function splitFactorAfter(splits, date) {
    let f = 1;
    for (const s of splits || []) if (s.date > date) f *= s.num / s.den;
    return f;
  }
  /** Yahoo ajuste les dividendes passés des divisions/attributions gratuites : on revient au montant réellement versé. */
  function unadjustDividends(divs, splits) {
    return divs.map((d) => ({ ...d, montant: round6(d.montant * splitFactorAfter(splits, d.exDate)) }));
  }
  function unadjustCloses(history, splits) {
    if (!splits || !splits.length) return history;
    return history.map(([d, c]) => [d, round6(c * splitFactorAfter(splits, d))]);
  }

  /** Dernier cours connu à une date (report du dernier cours de clôture). */
  function closeAt(history, date) {
    let lo = 0, hi = history.length - 1, ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (history[mid][0] <= date) { ans = history[mid][1]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // ------------------------------------------------------------ dividendes
  /**
   * Dividendes : calculés (parts détenues la veille du détachement × dividende brut),
   * rapprochés des lignes « Dividende » saisies, qui font foi.
   */
  function computeDividends(txs, market, instruments, today = todayISO()) {
    const inst = new Map((instruments || []).map((i) => [i.ticker, i]));
    const tickers = market && market.tickers ? market.tickers : {};
    const manual = sortTransactions(txs).filter((t) => t.type === "Dividende" && t.ticker);

    // 1. Événements calculés
    const computed = [];
    for (const [tk, m] of Object.entries(tickers)) {
      const ret = (inst.get(tk) && inst.get(tk).retenueSource) || 0;
      for (const d of m.dividends || []) {
        if (d.exDate > today) continue;
        const parts = positionAt(txs, tk, d.exDate, true);
        if (parts <= 0) continue;
        const brut = parts * d.montant;
        computed.push({ ticker: tk, exDate: d.exDate, parAction: d.montant, parts,
          brut: round2(brut), net: round2(brut * (1 - ret)), retenue: ret });
      }
    }
    computed.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));

    // 2. Rapprochement : chaque saisie manuelle prend l'événement calculé le plus proche
    //    dont le détachement précède le crédit de 0 à 45 jours (tolérance si la source date autrement).
    const used = new Set();
    const pairs = new Map(); // id saisie -> événement calculé
    for (const t of manual) {
      let best = null, bestGap = Infinity;
      computed.forEach((c, idx) => {
        if (used.has(idx) || c.ticker !== t.ticker) return;
        const gap = daysBetween(c.exDate, t.date);
        if (gap < -TOLERANCE_ANTERIORITE || gap > FENETRE_RAPPROCHEMENT) return;
        const score = Math.abs(gap) + Math.abs(c.net - montant(t)) / 10;
        if (score < bestGap) { bestGap = score; best = idx; }
      });
      if (best !== null) { used.add(best); pairs.set(t.id, computed[best]); }
    }

    // 3. Calibrage du décalage détachement -> crédit, par ticker
    const offsets = {};
    const gaps = {};
    for (const t of manual) {
      const c = pairs.get(t.id);
      if (!c || t.date < c.exDate) continue;
      (gaps[t.ticker] = gaps[t.ticker] || []).push(businessDaysBetween(c.exDate, t.date));
    }
    const allGaps = Object.values(gaps).flat();
    const defaut = allGaps.length ? Math.round(median(allGaps)) : DECALAGE_VERSEMENT_DEFAUT;
    for (const tk of Object.keys(tickers)) offsets[tk] = gaps[tk] ? Math.round(median(gaps[tk])) : defaut;

    // 4. Enregistrements finaux
    const records = [];
    for (const t of manual) {
      const c = pairs.get(t.id);
      const m = montant(t);
      const rec = { ticker: t.ticker, datePaiement: t.date, montant: round2(m), source: c ? "rapproché" : "saisi",
        saisieId: t.id, montantSaisi: round2(m), exDate: c ? c.exDate : null, parAction: c ? c.parAction : t.prix,
        parts: c ? c.parts : t.quantite, montantCalcule: c ? c.net : null, ecart: c ? round2(m - c.net) : null,
        explication: null };
      if (c && Math.abs(rec.ecart) > 1) rec.explication = explainGap(t, c);
      else if (c && t.date < c.exDate)
        rec.explication = `Crédit saisi le ${frDate(t.date)}, avant le détachement du ${frDate(c.exDate)} indiqué par la source`;
      if (!c) rec.explication = explainOrphan(t, tickers[t.ticker]);
      records.push(rec);
    }
    computed.forEach((c, idx) => {
      if (used.has(idx)) return;
      const pay = addBusinessDays(c.exDate, offsets[c.ticker] ?? defaut);
      records.push({ ticker: c.ticker, datePaiement: pay, datePaiementEstimee: true, montant: c.net,
        source: "calculé", saisieId: null, montantSaisi: null, exDate: c.exDate, parAction: c.parAction,
        parts: c.parts, montantCalcule: c.net, ecart: null,
        explication: pay > today ? "Détaché, versement attendu" : "Calculé : absent du carnet (non saisi)",
        aVenir: pay > today });
    });
    records.sort((a, b) => (a.datePaiement < b.datePaiement ? -1 : a.datePaiement > b.datePaiement ? 1 : 0));

    const encaisses = records.filter((r) => r.datePaiement <= today);
    return { records, encaisses, offsets, decalageDefaut: defaut, aggregate: aggregateDividends(encaisses) };
  }

  function explainGap(t, c) {
    const m = montant(t);
    if (Math.abs(t.quantite - c.parts) > 1e-9)
      return `Parts différentes : ${t.quantite} saisies, ${c.parts} détenues la veille du détachement selon le carnet`;
    if (Math.abs(t.prix - c.parAction) > 0.005)
      return `Montant par action différent : ${t.prix} saisi, ${round6(c.parAction)} selon la source`;
    return `Écart de ${round2(m - c.net)} € (arrondi ou retenue)`;
  }

  function explainOrphan(t, m) {
    const splits = (m && m.splits) || [];
    const s = splits.find((s) => daysBetween(s.date, t.date) >= -45 && daysBetween(s.date, t.date) <= 60);
    if (s) return `Indemnité de rompus probable (attribution gratuite ${s.num}:${s.den} du ${frDate(s.date)})`;
    if (m && (!m.dividends || !m.dividends.length)) return "Aucun dividende connu de la source pour cette ligne";
    return "Aucun détachement correspondant dans la source";
  }

  function aggregateDividends(records) {
    const byYear = {}, byYearMonth = {}, byTickerYearMonth = {};
    for (const r of records) {
      const y = r.datePaiement.slice(0, 4), mo = +r.datePaiement.slice(5, 7);
      byYear[y] = round2((byYear[y] || 0) + r.montant);
      byYearMonth[y] = byYearMonth[y] || Array(12).fill(0);
      byYearMonth[y][mo - 1] = round2(byYearMonth[y][mo - 1] + r.montant);
      const k = byTickerYearMonth[y] = byTickerYearMonth[y] || {};
      k[r.ticker] = k[r.ticker] || Array(12).fill(0);
      k[r.ticker][mo - 1] = round2(k[r.ticker][mo - 1] + r.montant);
    }
    return { byYear, byYearMonth, byTickerYearMonth, years: Object.keys(byYear).sort() };
  }

  /**
   * Dividendes à venir — ESTIMATIONS sauf date annoncée par la source.
   * Chaque détachement des 12 derniers mois est reconduit un an plus tard, avec le même montant
   * (ou le dernier montant connu pour les payeurs trimestriels). Si la source annonce
   * une date de détachement future, elle remplace la date estimée la plus proche.
   */
  function forecastDividends(txs, market, instruments, opts = {}) {
    const today = opts.today || todayISO();
    const horizon = addDays(today, opts.horizonDays || 365);
    const offsets = opts.offsets || {};
    const defaut = opts.decalageDefaut ?? DECALAGE_VERSEMENT_DEFAUT;
    const inst = new Map((instruments || []).map((i) => [i.ticker, i]));
    const ledger = computeLedger(txs, today);
    const events = [];
    const frequence = {};
    for (const [tk, l] of ledger.lines) {
      if (l.quantite <= 0) continue;
      const m = market && market.tickers && market.tickers[tk];
      const divs = (m && m.dividends) || [];
      if (!divs.length) continue;
      const ret = (inst.get(tk) && inst.get(tk).retenueSource) || 0;
      const last12 = divs.filter((d) => d.exDate > addDays(today, -365) && d.exDate <= today);
      const parAn = countPerYear(divs, today);
      frequence[tk] = parAn;
      const derniers = divs.filter((d) => d.exDate <= today);
      const dernier = derniers[derniers.length - 1];
      // Payeurs trimestriels : ramener les montants au dernier niveau observé
      // (dernier détachement comparé à celui de l'année précédente, borné à ±50 %).
      let croissance = 1;
      if (parAn >= 3 && dernier) {
        const anPasse = divs.filter((d) => Math.abs(daysBetween(d.exDate, addYears(dernier.exDate, -1))) <= 45);
        if (anPasse.length && anPasse[0].montant > 0)
          croissance = Math.min(1.5, Math.max(0.5, dernier.montant / anPasse[anPasse.length - 1].montant));
      }
      const proj = [];
      for (const d of last12) {
        let ex = addYears(d.exDate, 1);
        while (isWeekend(ex)) ex = addDays(ex, 1);
        let k = 1;
        while (ex <= today) { k++; ex = addYears(d.exDate, k); }
        // Montant du même versement l'an dernier (ajusté pour les trimestriels, sauf le dernier lui-même)
        const parAction = d === dernier ? d.montant : round6(d.montant * croissance);
        proj.push({ exDate: ex, parAction, base: d.exDate, fiabilite: "estimé" });
      }
      // Pas de détachement depuis 12 mois mais historique : reconduire le dernier
      if (!proj.length && dernier && daysBetween(dernier.exDate, today) < 730) {
        let ex = dernier.exDate;
        while (ex <= today) ex = addYears(ex, 1);
        proj.push({ exDate: ex, parAction: dernier.montant, base: dernier.exDate, fiabilite: "estimé" });
      }
      const annonce = m.nextExDate && m.nextExDate > today ? m.nextExDate : null;
      if (annonce) {
        let best = null;
        for (const p of proj) {
          const g = Math.abs(daysBetween(p.exDate, annonce));
          if (g <= 75 && (!best || g < Math.abs(daysBetween(best.exDate, annonce)))) best = p;
        }
        if (best) { best.exDate = annonce; best.fiabilite = "date confirmée"; }
        else if (dernier) proj.push({ exDate: annonce, parAction: dernier.montant, base: dernier.exDate, fiabilite: "date confirmée" });
      }
      for (const p of proj) {
        if (p.exDate > horizon) continue;
        const brut = l.quantite * p.parAction;
        events.push({ ticker: tk, exDate: p.exDate,
          datePaiement: addBusinessDays(p.exDate, offsets[tk] ?? defaut),
          parAction: p.parAction, parts: l.quantite, montant: round2(brut * (1 - ret)),
          fiabilite: p.fiabilite, // « estimé » ou « date confirmée » (le montant reste une estimation)
          montantEstime: true, reference: p.base });
      }
    }
    events.sort((a, b) => (a.exDate < b.exDate ? -1 : 1));
    return { events, frequence, total: round2(sum(events, (e) => e.montant)) };
  }

  function countPerYear(divs, today) {
    // Nombre médian de détachements par an sur les 3 dernières années complètes ou glissantes.
    const counts = [];
    for (let k = 0; k < 3; k++) {
      const to = addDays(today, -365 * k), from = addDays(today, -365 * (k + 1));
      const n = divs.filter((d) => d.exDate > from && d.exDate <= to).length;
      if (n || k === 0) counts.push(n);
    }
    return Math.round(median(counts) || 0);
  }

  // ------------------------------------------------------------ synthèse
  /** Synthèse complète du portefeuille à aujourd'hui. */
  function computePortfolio(txs, market, instruments, opts = {}) {
    const today = opts.today || todayISO();
    const ledger = computeLedger(txs, today);
    const div = computeDividends(txs, market, instruments, today);
    const inst = new Map((instruments || []).map((i) => [i.ticker, i]));
    const tickers = (market && market.tickers) || {};
    const lignes = [], soldees = [];
    for (const l of ledger.lines.values()) {
      const m = tickers[l.ticker] || {};
      const i = inst.get(l.ticker) || { nom: l.ticker, isin: "" };
      const divLigne = round2(sum(div.encaisses.filter((r) => r.ticker === l.ticker), (r) => r.montant));
      const base = { ticker: l.ticker, nom: i.nom, isin: i.isin, type: i.type, distribution: i.distribution,
        realise: round2(l.realise), ventes: l.ventes, investiTotal: round2(l.investiTotal), dividendes: divLigne };
      if (l.quantite > 0) {
        const cours = typeof m.price === "number" ? m.price : null;
        const valeur = cours !== null ? l.quantite * cours : null;
        lignes.push({ ...base, quantite: l.quantite, pru: l.pru, cout: l.cout, cours,
          coursDate: m.priceTime || null, variationJour: m.changePct ?? null,
          variationJourEur: typeof m.change === "number" ? m.change * l.quantite : null,
          valeur, plusValue: valeur !== null ? valeur - l.cout : null,
          plusValuePct: valeur !== null && l.cout > 0 ? (valeur - l.cout) / l.cout : null,
          indisponible: cours === null });
      } else if (l.achats > 0) {
        soldees.push({ ...base, dateSortie: l.derniereDate });
      }
    }
    const valeurTitres = sum(lignes, (l) => l.valeur || 0);
    for (const l of lignes) l.poids = valeurTitres > 0 && l.valeur !== null ? l.valeur / valeurTitres : null;
    const coutTotal = sum(lignes, (l) => l.cout);
    const realise = sum([...lignes, ...soldees], (l) => l.realise);
    const dividendes = sum(div.encaisses, (r) => r.montant);
    // Cash disponible = versements − achats + ventes + dividendes encaissés (dividendes = cash, pas un apport)
    const cash = ledger.versements - ledger.achats + ledger.ventes + dividendes;
    const plusValueLatente = valeurTitres - coutTotal;
    const variationJour = sum(lignes, (l) => l.variationJourEur || 0);
    const annee = today.slice(0, 4);
    return {
      today, lignes, soldees, issues: ledger.issues, dividendes: div,
      totaux: {
        valeurTitres: round2(valeurTitres), cash: round2(cash), valeurTotale: round2(valeurTitres + cash),
        versements: ledger.versements, plafondPEA: PLAFOND_PEA, achats: ledger.achats, ventes: ledger.ventes,
        coutRevient: round2(coutTotal), plusValueLatente: round2(plusValueLatente),
        plusValueLatentePct: coutTotal > 0 ? plusValueLatente / coutTotal : null,
        plusValuesRealisees: round2(realise), dividendesCumules: round2(dividendes),
        dividendesAnnee: round2(div.aggregate.byYear[annee] || 0),
        // Performance globale : latente + réalisée + dividendes
        performanceTotale: round2(plusValueLatente + realise + dividendes),
        // Rendement simple : (valeur titres + cash − versements) / versements
        rendementSimple: ledger.versements > 0 ? (valeurTitres + cash - ledger.versements) / ledger.versements : null,
        variationJour: round2(variationJour),
        lignesIndisponibles: lignes.filter((l) => l.indisponible).map((l) => l.ticker),
      },
    };
  }

  /** Valeur du portefeuille (titres + cash) et versements cumulés, jour par jour (échantillonné). */
  function valueHistory(txs, market, opts = {}) {
    const today = opts.today || todayISO();
    const step = opts.stepDays || 1;
    const sorted = sortTransactions(txs).filter((t) => t.date <= today);
    if (!sorted.length) return [];
    const tickers = (market && market.tickers) || {};
    const div = opts.dividendes || computeDividends(txs, market, opts.instruments, today).encaisses;
    const out = [];
    const pos = {};
    let versements = 0, cash = 0, i = 0, j = 0;
    const divs = [...div].sort((a, b) => (a.datePaiement < b.datePaiement ? -1 : 1));
    for (let d = sorted[0].date, n = 0; d <= today; d = addDays(d, 1), n++) {
      while (i < sorted.length && sorted[i].date <= d) {
        const t = sorted[i++], m = montant(t);
        if (TYPES_FLUX.includes(t.type)) { versements += m; cash += m; }
        else if (t.type === "Achat") { pos[t.ticker] = (pos[t.ticker] || 0) + t.quantite; cash -= m; }
        else if (t.type === "Vente") { pos[t.ticker] = (pos[t.ticker] || 0) - t.quantite; cash += m; }
      }
      while (j < divs.length && divs[j].datePaiement <= d) cash += divs[j++].montant;
      if (n % step !== 0 && d !== today) continue;
      let titres = 0, complet = true;
      for (const [tk, q] of Object.entries(pos)) {
        if (q <= 1e-9) continue;
        const h = tickers[tk] && tickers[tk].history;
        let c = h ? closeAt(h, d) : null;
        if (d === today && tickers[tk] && typeof tickers[tk].price === "number") c = tickers[tk].price;
        if (c === null) { complet = false; continue; }
        titres += q * c;
      }
      out.push({ date: d, valeur: round2(titres + cash), titres: round2(titres), cash: round2(cash),
        versements: round2(versements), complet });
    }
    return out;
  }

  /**
   * Rendement annualisé pondéré des flux (XIRR) : versements = flux sortants,
   * valeur actuelle (titres + cash) = flux entrant final.
   */
  function xirr(flows) {
    if (flows.length < 2) return null;
    const t0 = toUTC(flows[0].date);
    const yrs = flows.map((f) => (toUTC(f.date) - t0) / (365.25 * 86400000));
    const npv = (r) => flows.reduce((s, f, k) => s + f.montant / Math.pow(1 + r, yrs[k]), 0);
    let lo = -0.99, hi = 10;
    if (npv(lo) * npv(hi) > 0) return null;
    for (let k = 0; k < 200; k++) {
      const mid = (lo + hi) / 2;
      if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
    }
    return (lo + hi) / 2;
  }
  function portfolioXirr(txs, valeurTotale, today = todayISO()) {
    const flows = sortTransactions(txs).filter((t) => TYPES_FLUX.includes(t.type) && t.date <= today)
      .map((t) => ({ date: t.date, montant: -montant(t) }));
    if (!flows.length) return null;
    flows.push({ date: today, montant: valeurTotale });
    return xirr(flows);
  }

  // ------------------------------------------------------------ fiscalité PEA
  // Taux en vigueur au 01/01/2026 : la LFSS 2026 porte la CSG de 9,2 % à 10,6 %, donc les prélèvements
  // sociaux de 17,2 % à 18,6 %. À mettre à jour ici si la loi change. Simplification assumée : le taux du
  // jour s'applique à tout le gain (pas de taux historiques par période d'acquisition).
  const FISCALITE_PEA = { prelevementsSociaux: 0.186, impotRevenu: 0.128, ancienneteAns: 5, enVigueurDepuis: "2026-01-01" };
  // Grille de courtage par défaut : ESTIMATION déduite des ordres 2023 (≈ 0,5 %, minimum 1,99 €), à remplacer par la vraie.
  const FRAIS_DEFAUT = { taux: 0.005, minimum: 1.99 };

  /** Frais de courtage d'un ordre : max(minimum, montant × taux). */
  function fraisCourtage(montant, grille = FRAIS_DEFAUT) {
    if (!(montant > 0)) return 0;
    return round2(Math.max(grille.minimum || 0, montant * (grille.taux || 0)));
  }

  /** Jalon des 5 ans : date anniversaire, atteint ou non à `date`, jours restants. */
  function anciennetePEA(dateOuverture, date = todayISO()) {
    const jalon = addYears(dateOuverture, FISCALITE_PEA.ancienneteAns);
    const atteint = date >= jalon;
    return { dateOuverture, jalon, atteint, joursRestants: atteint ? 0 : daysBetween(date, jalon),
      progression: Math.min(1, Math.max(0, daysBetween(dateOuverture, date) / daysBetween(dateOuverture, jalon))) };
  }

  /** Taux global sur la part de gain d'un retrait : PS seuls après 5 ans, PS + IR avant. */
  function tauxRetraitPEA(dateOuverture, date = todayISO()) {
    const F = FISCALITE_PEA;
    return anciennetePEA(dateOuverture, date).atteint
      ? { taux: F.prelevementsSociaux, detail: { prelevementsSociaux: F.prelevementsSociaux, impotRevenu: 0 } }
      : { taux: F.prelevementsSociaux + F.impotRevenu, detail: { prelevementsSociaux: F.prelevementsSociaux, impotRevenu: F.impotRevenu } };
  }

  /** Vente d'une ligne entière au cours actuel : rien n'est imposé tant que l'argent reste dans le PEA. */
  function simulerVente(ligne, grille = FRAIS_DEFAUT) {
    if (ligne.cours === null || ligne.cours === undefined) return null;
    const brut = round2(ligne.quantite * ligne.cours);
    const frais = fraisCourtage(brut, grille);
    const net = round2(brut - frais);
    return { brut, frais, net, plusValue: round2(net - ligne.cout) };
  }

  /**
   * Retrait du PEA (estimation). Le gain imposable d'un retrait = montant × (valeur du plan − versements) / valeur du plan.
   * Avant 5 ans, un retrait clôture le plan : on simule alors le retrait de tout.
   * Les titres à vendre pour dégager le montant supportent leurs frais de courtage (grille ligne par ligne).
   */
  function simulerRetraitPEA({ lignes, cash, versements, montant, dateOuverture, date = todayISO(), grille = FRAIS_DEFAUT }) {
    const anc = anciennetePEA(dateOuverture, date);
    const ventes = lignes.filter((l) => l.cours !== null && l.cours !== undefined).map((l) => simulerVente(l, grille));
    const fraisTout = sum(ventes, (v) => v.frais);
    const valeurNetteTout = round2(sum(ventes, (v) => v.net) + cash); // ce que vaut le plan une fois tout vendu
    const cloture = !anc.atteint;
    const demande = cloture || montant === undefined || montant === null ? valeurNetteTout : Math.min(Math.max(0, montant), valeurNetteTout);
    // Frais : nuls si le cash suffit ; sinon au prorata des titres à vendre (tout vendre = frais exacts ligne par ligne).
    const brutTitres = sum(lignes, (l) => (l.cours !== null && l.cours !== undefined ? l.quantite * l.cours : 0));
    const besoin = Math.max(0, demande - cash);
    const frais = demande >= valeurNetteTout ? fraisTout : brutTitres > 0 ? round2(fraisTout * Math.min(1, besoin / (brutTitres - fraisTout))) : 0;
    const gainPlan = round2(valeurNetteTout - versements);
    const partGain = gainPlan > 0 && valeurNetteTout > 0 ? round2(demande * gainPlan / valeurNetteTout) : 0;
    const { taux, detail } = tauxRetraitPEA(dateOuverture, date);
    const impot = round2(partGain * taux);
    return { anciennete: anc, cloture, montant: round2(demande), fraisVente: frais, valeurNetteTout, gainPlan, partGain,
      taux, detail, impot, net: round2(demande - impot), estimation: true };
  }

  // ------------------------------------------------------------ formats
  const frDate = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "");

  return {
    PLAFOND_PEA, TYPES, TYPES_FLUX,
    addDays, addBusinessDays, businessDaysBetween, daysBetween, todayISO, frDate, round2,
    sortTransactions, positionAt, computeLedger, validateTransaction,
    splitFactorAfter, unadjustDividends, unadjustCloses, closeAt,
    computeDividends, aggregateDividends, forecastDividends,
    computePortfolio, valueHistory, xirr, portfolioXirr,
    FISCALITE_PEA, FRAIS_DEFAUT, fraisCourtage, anciennetePEA, tauxRetraitPEA, simulerVente, simulerRetraitPEA,
  };
});
