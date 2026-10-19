/*
 * Suivi PEA — interface. Le calcul est délégué à PEAEngine (js/engine.js).
 * Deux modes :
 *  - servi par scripts/serve.mjs (http://127.0.0.1) : le carnet du profil choisi est enregistré dans data/ ;
 *  - ouvert en double-clic (file://) : données lues depuis data/*.js, modifications dans le navigateur.
 * Dans les deux cas une copie est gardée dans localStorage. Aucune donnée du carnet ne part sur le réseau.
 */
(function () {
  "use strict";
  const E = window.PEAEngine, C = window.PEACharts;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

  const state = {
    server: false, carnet: null, instruments: null, market: null, profils: [], profil: null,
    view: "portefeuille", sort: { key: "valeur", dir: -1 }, histRange: 0, editingId: null,
    xirr: false, recOnly: true, divYear: null, refreshing: false, saveError: null, retraitMontant: null,
  };
  let P = null, F = null, H = null; // portefeuille, prévisions, historique (recalculés à chaque changement)

  // ------------------------------------------------------------------ formats
  const nf = (d) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const NF2 = nf(2), NF0 = nf(0), NF1 = nf(1);
  const MINUS = "−";
  const eur = (v, d = 2) => (v === null || v === undefined || !isFinite(v) ? "—" : (v < 0 ? MINUS : "") + (d === 0 ? NF0 : NF2).format(Math.abs(v)) + " €");
  const eurS = (v, d = 2) => (v === null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? MINUS : "") + (d === 0 ? NF0 : NF2).format(Math.abs(v)) + " €");
  const pctS = (v) => (v === null || !isFinite(v) ? "—" : (v > 0 ? "+" : v < 0 ? MINUS : "") + NF2.format(Math.abs(v * 100)) + " %");
  const pct = (v, d = 2) => (v === null || !isFinite(v) ? "—" : (d === 1 ? NF1 : NF2).format(v * 100) + " %");
  const qty = (v) => new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 6 }).format(v);
  const prix = (v) => (v === null || !isFinite(v) ? "—" : new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v) + " €");
  const cls = (v) => (v > 0 ? "pos" : v < 0 ? "neg" : "");
  const d8 = (s) => E.frDate(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const today = () => E.todayISO();
  const fmtDateTime = (iso) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString("fr-FR")} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  };

  // ---------------------------------------------------------------- stockage
  const LS = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };
  async function fetchJSON(url, opts) {
    const r = await fetch(url, { cache: "no-store", ...opts });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  const newest = (a, b) => (!a ? b : !b ? a : (a.updatedAt || "") >= (b.updatedAt || "") ? a : b);

  // Chaque profil (personne) a son propre carnet ; référentiel et cours sont publics et partagés.
  const lsCarnetKey = () => `pea.carnet.${state.profil.id}`;
  const apiCarnet = () => `api/carnet?profil=${encodeURIComponent(state.profil.id)}`;

  async function load() {
    if (location.protocol.startsWith("http")) {
      try { state.server = (await fetchJSON("api/status")).ok === true; } catch { state.server = false; }
    }
    const profils = (state.server && (await fetchJSON("api/profils").catch(() => null))?.profils) || window.PEA_PROFILS || [{ id: "nicolas", nom: "Nicolas" }];
    state.profils = profils;
    // ?profil=<id> dans l'adresse (favori par personne) prime sur le dernier profil utilisé.
    const demande = new URLSearchParams(location.search).get("profil");
    state.profil = profils.find((p) => p.id === demande) || profils.find((p) => p.id === LS.get("pea.profil")) || profils[0];
    LS.set("pea.profil", state.profil.id);
    // Ancienne clé unique (avant les profils) : elle appartient au premier profil.
    if (state.profil === profils[0] && !LS.get(lsCarnetKey()) && LS.get("pea.carnet")) LS.set(lsCarnetKey(), LS.get("pea.carnet"));
    const carnets = window.PEA_CARNETS || {};
    let fileCarnet = carnets[state.profil.id] || (state.profil === profils[0] ? window.PEA_CARNET : null);
    let fileInst = window.PEA_INSTRUMENTS, market = window.PEA_MARKET;
    if (state.server) {
      fileCarnet = await fetchJSON(apiCarnet()).catch(() => null);
      fileInst = await fetchJSON("api/instruments").catch(() => null);
      market = await fetchJSON("data/market.json").catch(() => null);
    }
    const lsCarnet = LS.get(lsCarnetKey()), lsInst = LS.get("pea.instruments");
    state.carnet = newest(fileCarnet, lsCarnet) || { version: 1, updatedAt: null, transactions: [] };
    state.instruments = newest(fileInst, lsInst) || { version: 1, updatedAt: null, instruments: [] };
    state.market = market || LS.get("pea.market") || { generatedAt: null, tickers: {} };
    if (market) LS.set("pea.market", market);
    LS.set(lsCarnetKey(), state.carnet);
    LS.set("pea.instruments", state.instruments);
    // Le navigateur a une version plus récente que le fichier (modifs faites en double-clic) : on la pousse.
    if (state.server) {
      if (state.carnet === lsCarnet && lsCarnet !== fileCarnet) await pushServer("carnet");
      if (state.instruments === lsInst && lsInst !== fileInst) await pushServer("instruments");
    }
    const prefs = LS.get("pea.prefs") || {};
    Object.assign(state, { xirr: !!prefs.xirr, recOnly: prefs.recOnly !== false, sort: prefs.sort || state.sort });
  }
  const savePrefs = () => LS.set("pea.prefs", { xirr: state.xirr, recOnly: state.recOnly, sort: state.sort });

  async function pushServer(kind) {
    const obj = kind === "carnet" ? state.carnet : state.instruments;
    try {
      await fetchJSON(kind === "carnet" ? apiCarnet() : `api/${kind}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
      state.saveError = null;
    } catch (e) {
      state.saveError = `Enregistrement du ${kind === "carnet" ? "carnet" : "référentiel"} impossible (${e.message}) : vos données sont conservées dans ce navigateur.`;
    }
  }
  async function persist(kind) {
    const obj = kind === "carnet" ? state.carnet : state.instruments;
    obj.updatedAt = new Date().toISOString();
    if (!LS.set(kind === "carnet" ? lsCarnetKey() : `pea.${kind}`, obj)) state.saveError = "Stockage du navigateur indisponible : exportez une sauvegarde JSON.";
    if (state.server) await pushServer(kind);
    renderBanner();
  }

  async function refreshMarket(manual) {
    if (!state.server || state.refreshing) return;
    state.refreshing = true;
    renderStatus();
    try {
      state.market = await fetchJSON("api/refresh", { method: "POST" });
      LS.set("pea.market", state.market);
      if (manual) toast("Cours et dividendes à jour");
    } catch (e) {
      if (manual) toast("Source de cours injoignable");
    } finally {
      state.refreshing = false;
      recompute();
      renderAll();
    }
  }

  // ------------------------------------------------------------------ calcul
  const inst = () => state.instruments.instruments;
  const instByTicker = (tk) => inst().find((i) => i.ticker === tk);
  const nomDe = (tk) => (instByTicker(tk) || {}).nom || tk;
  function renderRetrait() {
    const t = P.totaux, o = ouverturePEA(), g = grille();
    const r = E.simulerRetraitPEA({ lignes: P.lignes, cash: t.cash, versements: t.versements, montant: state.retraitMontant,
      dateOuverture: o.date, date: today(), grille: g });
    const a = r.anciennete;
    const setIf = (sel, v) => { const el = $(sel); if (document.activeElement !== el) el.value = v; };
    setIf("#p-ouverture", o.date);
    setIf("#p-frais-taux", +(g.taux * 100).toFixed(3));
    setIf("#p-frais-min", g.minimum);
    $("#r-montant").disabled = r.cloture;
    if (r.cloture) $("#r-montant").value = "";
    $("#jalon").innerHTML = (a.atteint
      ? `<strong>PEA de plus de 5 ans</strong> depuis le ${d8(a.jalon)} : seuls les prélèvements sociaux s'appliquent aux gains, et le plan reste ouvert après un retrait.`
      : `<strong>Jalon des 5 ans : ${d8(a.jalon)}</strong>, dans ${NF0.format(a.joursRestants)} jours. Avant cette date, gains taxés à ${pct(r.taux, 1)} et retrait = clôture du PEA ; après, ${pct(E.FISCALITE_PEA.prelevementsSociaux, 1)} seulement.`)
      + `<div class="meter" role="meter" aria-valuenow="${Math.round(a.progression * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="Progression vers les 5 ans"><i style="width:${a.progression * 100}%"></i></div>`
      + (o.deduite ? ` <span class="tag est">date déduite du 1er ordre du carnet, à confirmer</span>` : "");
    const al = $("#retrait-alerte");
    al.hidden = !r.cloture;
    al.textContent = r.cloture ? `Avant le ${d8(a.jalon)}, tout retrait clôture le PEA (sauf cas particuliers) : la simulation porte donc sur la totalité du plan.` : "";
    const detailTaux = r.detail.impotRevenu ? `${pct(r.detail.impotRevenu, 1)} impôt + ${pct(r.detail.prelevementsSociaux, 1)} prél. sociaux` : "prélèvements sociaux seuls";
    const kv = [
      [r.cloture ? "Valeur du PEA une fois tout vendu" : "Montant retiré", eur(r.montant)],
      [r.cloture ? "Courtage déjà déduit (vente de tous les titres)" : "Courtage pour vendre les titres (pris dans le PEA)", `${eur(r.fraisVente)}${grilleEstimee() ? ' <span class="tag est">grille estimée</span>' : ""}`],
      ["Gain du plan (valeur nette − versements)", `<span class="${cls(r.gainPlan)}">${eurS(r.gainPlan)}</span>`],
      ["Part de gain dans ce retrait", eur(r.partGain)],
      ["Taux appliqué", `${pct(r.taux, 1)} <span class="muted">(${detailTaux})</span>`],
      ["Impôt estimé", `<span class="${r.impot > 0 ? "neg" : ""}">${r.impot > 0 ? eurS(-r.impot) : eur(0)}</span>`],
    ];
    $("#retrait").innerHTML = kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")
      + `<div class="total"><dt>Net versé sur ton compte bancaire</dt><dd>${eur(r.net)}</dd></div>`;
    const versementsEstimes = state.carnet.transactions.some((x) => E.TYPES_FLUX.includes(x.type) && /estim/i.test(x.libelle || ""));
    $("#retrait-note").textContent = `Taux en vigueur depuis le ${d8(E.FISCALITE_PEA.enVigueurDepuis)} (CSG portée à 10,6 % par la LFSS 2026). Calcul indicatif : `
      + "taux du jour appliqué à tout le gain (sans taux historiques), courtage estimé ligne par ligne au cours actuel."
      + (r.gainPlan <= 0 ? " Le plan est en moins-value : aucun impôt." : "")
      + (versementsEstimes ? " Attention : une partie des versements de ce carnet est estimée, le gain l'est donc aussi." : "");
  }

  // Paramètres propres au profil, rangés dans son carnet (date d'ouverture du PEA, grille de courtage).
  const params = () => state.carnet.parametres || (state.carnet.parametres = {});
  function ouverturePEA() {
    if (params().dateOuverturePEA) return { date: params().dateOuverturePEA, deduite: false };
    const first = E.sortTransactions(state.carnet.transactions)[0];
    return { date: first ? first.date : today(), deduite: true };
  }
  const grille = () => params().frais || E.FRAIS_DEFAUT;
  const grilleEstimee = () => !params().frais;

  function recompute() {
    const tx = state.carnet.transactions;
    P = E.computePortfolio(tx, state.market, inst(), { today: today() });
    for (const l of P.lignes) {
      const v = E.simulerVente(l, grille());
      Object.assign(l, { venteNette: v ? v.net : null, venteFrais: v ? v.frais : null, ventePV: v ? v.plusValue : null });
    }
    F = E.forecastDividends(tx, state.market, inst(), { today: today(), offsets: P.dividendes.offsets, decalageDefaut: P.dividendes.decalageDefaut });
    H = null; // historique calculé à la demande (graphique)
  }
  function upcoming() {
    // Dividendes déjà détachés mais pas encore crédités (montant connu) + prévisions
    const detaches = P.dividendes.records.filter((r) => r.aVenir).map((r) => ({ ticker: r.ticker, exDate: r.exDate,
      datePaiement: r.datePaiement, parAction: r.parAction, parts: r.parts, montant: r.montant, fiabilite: "détaché" }));
    return [...detaches, ...F.events].sort((a, b) => (a.datePaiement < b.datePaiement ? -1 : a.datePaiement > b.datePaiement ? 1 : 0));
  }
  const tagFiab = (f) => f === "détaché" ? '<span class="tag ok" title="Montant connu, date de versement estimée">détaché</span>'
    : f === "date confirmée" ? '<span class="tag info" title="Date de détachement annoncée par la source ; montant estimé">date confirmée</span>'
      : '<span class="tag est" title="Date et montant estimés à partir de l\'historique">estimé</span>';

  // ----------------------------------------------------------------- rendu
  function renderAll() {
    renderStatus();
    renderBanner();
    renderCards();
    renderPortefeuille();
    renderCarnet();
    renderDividendes();
    $("#foot").textContent = `${state.carnet.transactions.length} ordres · carnet de ${state.profil.nom} ${state.server ? "enregistré dans data/" : "enregistré dans ce navigateur"}`
      + (state.carnet.updatedAt ? ` · modifié le ${fmtDateTime(state.carnet.updatedAt)}` : "") + " · aucune donnée personnelle n'est envoyée sur le réseau";
  }

  function marketInfo() {
    const ts = Object.values(state.market.tickers || {});
    const times = ts.map((t) => t.priceTime).filter(Boolean).sort();
    const errors = ts.filter((t) => t.error);
    return { last: times[times.length - 1] || null, errors, total: ts.length };
  }

  function renderStatus() {
    const s = $("#status");
    const mi = marketInfo();
    const btn = $("#btn-refresh");
    btn.hidden = !state.server;
    btn.disabled = state.refreshing;
    btn.textContent = state.refreshing ? "Mise à jour…" : "Actualiser les cours";
    if (!mi.last) {
      s.innerHTML = '<span class="dot err"></span>Aucun cours disponible' + (state.server ? "" : " — lancez scripts/refresh-market.mjs");
      return;
    }
    const ageH = (Date.now() - Date.parse(mi.last)) / 3600000;
    const stale = ageH > 72 || mi.errors.length > 0;
    let txt = `Cours du ${fmtDateTime(mi.last)}`;
    if (mi.errors.length) txt += ` · source injoignable pour ${mi.errors.length} ligne(s), derniers cours connus affichés`;
    if (state.refreshing) txt += " · mise à jour…";
    s.innerHTML = `<span class="dot ${mi.errors.length === mi.total ? "err" : stale ? "stale" : ""}"></span>${esc(txt)}`;
  }

  function renderBanner() {
    const b = $("#banner");
    const msgs = [];
    let err = false;
    if (state.saveError) { msgs.push(state.saveError); err = true; }
    if (P && P.issues.length) { msgs.push(`Incohérence dans le carnet : ${P.issues.map((i) => i.message).join(" ; ")}`); err = true; }
    if (!state.server && location.protocol === "file:")
      msgs.push("Ouvert sans serveur : vos saisies sont gardées dans ce navigateur (pensez à « Exporter / Sauvegarde complète »). Pour écrire dans data/ et actualiser les cours depuis l'app, lancez ./lancer.sh.");
    if (!state.carnet.transactions.length) msgs.push("Carnet vide : ajoutez votre premier ordre dans l'onglet « Carnet d'ordres », ou importez le classeur avec scripts/import-excel.py.");
    b.hidden = !msgs.length;
    b.className = "banner" + (err ? " err" : "");
    b.innerHTML = msgs.map(esc).join("<br>");
  }

  function card(label, value, sub, valueCls = "") {
    return `<div class="card"><div class="label">${label}</div><div class="value ${valueCls}">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
  }

  function renderCards() {
    const t = P.totaux;
    const up = upcoming();
    const next = up[0];
    const year = today().slice(0, 4);
    const resteAnnee = up.filter((e) => e.datePaiement.slice(0, 4) === year).reduce((s, e) => s + e.montant, 0);
    const varPct = t.valeurTitres - t.variationJour > 0 ? t.variationJour / (t.valeurTitres - t.variationJour) : null;
    const plafond = t.versements / t.plafondPEA;
    const anc = E.anciennetePEA(ouverturePEA().date, today());
    const jalonTxt = anc.atteint ? `PEA de plus de 5 ans depuis le ${d8(anc.jalon)}` : `5 ans le ${d8(anc.jalon)} · dans ${NF0.format(anc.joursRestants)} j`;
    const html = [
      card("Valeur du portefeuille", eur(t.valeurTitres),
        `<span class="num ${cls(t.variationJour)}">${eurS(t.variationJour)} (${pctS(varPct)})</span> aujourd'hui<br>Liquidités <span class="num">${eur(t.cash)}</span>`),
      card("Versements", eur(t.versements),
        `${pct(plafond, 1)} du plafond PEA (${eur(t.plafondPEA, 0)})<div class="meter" role="meter" aria-valuenow="${Math.round(plafond * 100)}" aria-valuemin="0" aria-valuemax="100" aria-label="Plafond PEA utilisé"><i style="width:${Math.min(100, plafond * 100)}%"></i></div>${jalonTxt}`),
      card("Plus-value latente", `<span class="${cls(t.plusValueLatente)}">${eurS(t.plusValueLatente)}</span>`,
        `<span class="num ${cls(t.plusValueLatentePct)}">${pctS(t.plusValueLatentePct)}</span> sur le coût de revient<br>Avec dividendes et PV réalisées : <span class="num ${cls(t.performanceTotale)}">${eurS(t.performanceTotale)}</span>`),
      card(`Dividendes perçus ${year}`, eur(t.dividendesAnnee),
        resteAnnee > 0 ? `+ <span class="num">${eur(resteAnnee)}</span> attendus d'ici le 31/12 <span class="tag est">estimé</span>` : `Cumul depuis l'ouverture : <span class="num">${eur(t.dividendesCumules)}</span>`),
      next ? card("Prochain dividende", eur(next.montant),
        `${esc(nomDe(next.ticker))} · versement ~${d8(next.datePaiement)}<br>dans ${E.daysBetween(today(), next.datePaiement)} j ${tagFiab(next.fiabilite)}`)
        : card("Prochain dividende", "—", "Aucune ligne distribuante détenue"),
    ];
    $("#cards").innerHTML = html.join("");
  }

  // ---------------------------------------------------------- portefeuille
  const COLS_PF = [
    { key: "nom", label: "Ligne" }, { key: "isin", label: "ISIN" }, { key: "quantite", label: "Parts", r: 1 },
    { key: "pru", label: "PRU", r: 1 }, { key: "cours", label: "Cours", r: 1 }, { key: "valeur", label: "Valeur", r: 1 },
    { key: "plusValue", label: "+/− €", r: 1 }, { key: "plusValuePct", label: "+/− %", r: 1 }, { key: "venteNette", label: "Si je vends", r: 1 }, { key: "poids", label: "Poids", r: 1 },
  ];
  function renderPortefeuille() {
    const t = P.totaux;
    const { key, dir } = state.sort;
    const rows = [...P.lignes].sort((a, b) => {
      const x = a[key], y = b[key];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === "string" ? x.localeCompare(y, "fr") : x - y) * dir;
    });
    $("#pf-count").textContent = `${rows.length} ligne${rows.length > 1 ? "s" : ""}`;
    const head = `<thead><tr>${COLS_PF.map((c) => `<th data-key="${c.key}" class="${c.r ? "r" : ""}" scope="col" ${key === c.key ? `aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""} tabindex="0">${c.label}</th>`).join("")}</tr></thead>`;
    const body = rows.map((l) => `<tr>
      <td><span class="name">${esc(l.nom)}</span><span class="sub">${esc(l.ticker)}</span></td>
      <td>${l.isin ? `<span class="num">${esc(l.isin)}</span>` : '<span class="tag muted">à compléter</span>'}</td>
      <td class="r">${qty(l.quantite)}</td>
      <td class="r">${prix(l.pru)}</td>
      <td class="r">${l.indisponible ? '<span class="tag err">indisponible</span>' : `${prix(l.cours)}<span class="sub ${cls(l.variationJour)}">${pctS(l.variationJour)}</span>`}</td>
      <td class="r">${eur(l.valeur)}</td>
      <td class="r ${cls(l.plusValue)}">${eurS(l.plusValue)}</td>
      <td class="r ${cls(l.plusValuePct)}">${pctS(l.plusValuePct)}</td>
      <td class="r" title="Vente de toute la ligne au cours actuel, courtage déduit (estimé). Aucun impôt tant que l'argent reste dans le PEA.">${eur(l.venteNette)}<span class="sub ${cls(l.ventePV)}">${l.ventePV === null ? "" : `${eurS(l.ventePV)} · frais ${eur(l.venteFrais)}`}</span></td>
      <td class="r">${pct(l.poids, 1)}</td></tr>`).join("");
    const foot = `<tfoot><tr><td>Total</td><td></td><td></td><td></td><td></td><td class="r">${eur(t.valeurTitres)}</td>
      <td class="r ${cls(t.plusValueLatente)}">${eurS(t.plusValueLatente)}</td><td class="r ${cls(t.plusValueLatentePct)}">${pctS(t.plusValueLatentePct)}</td><td class="r">${eur(P.lignes.reduce((a, l) => a + (l.venteNette || 0), 0))}</td><td class="r">100 %</td></tr></tfoot>`;
    renderRetrait();
    $("#pf-table").innerHTML = rows.length ? head + `<tbody>${body}</tbody>` + foot : '<tbody><tr><td class="empty">Aucune ligne détenue.</td></tr></tbody>';

    // Performance
    const xirr = state.xirr ? E.portfolioXirr(state.carnet.transactions, t.valeurTotale, today()) : null;
    const kv = [
      ["Coût de revient des lignes détenues", eur(t.coutRevient)],
      ["Valeur de marché des titres", eur(t.valeurTitres)],
      ["Plus-value latente", `<span class="${cls(t.plusValueLatente)}">${eurS(t.plusValueLatente)} (${pctS(t.plusValueLatentePct)})</span>`],
      ["Plus-values réalisées (ventes)", `<span class="${cls(t.plusValuesRealisees)}">${eurS(t.plusValuesRealisees)}</span>`],
      ["Dividendes encaissés (cumul)", `<span class="${cls(t.dividendesCumules)}">${eurS(t.dividendesCumules)}</span>`],
      ["Performance totale (latente + réalisée + dividendes)", `<span class="${cls(t.performanceTotale)}">${eurS(t.performanceTotale)}</span>`],
      ["Liquidités disponibles", eur(t.cash)],
      ["Valeur totale du PEA (titres + liquidités)", eur(t.valeurTotale)],
      ["Rendement simple sur versements", `<span class="${cls(t.rendementSimple)}">${pctS(t.rendementSimple)}</span>`],
    ];
    if (state.xirr) kv.push(["Rendement annualisé pondéré des flux (XIRR)", `<span class="${cls(xirr)}">${xirr === null ? "—" : pctS(xirr)} / an</span>`]);
    $("#perf").innerHTML = kv.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    $("#opt-xirr").checked = state.xirr;

    // Lignes soldées
    const s = P.soldees;
    $("#closed-count").textContent = s.length ? `${s.length} ligne${s.length > 1 ? "s" : ""} · ${eurS(s.reduce((a, l) => a + l.realise, 0))} réalisés` : "aucune";
    $("#closed-table").innerHTML = s.length ? `<thead><tr><th>Ligne</th><th class="r">Investi</th><th class="r">Produit des ventes</th><th class="r">Plus-value réalisée</th><th class="r">Dividendes perçus</th><th>Sortie</th></tr></thead><tbody>${
      s.map((l) => {
        const produit = l.ventes.reduce((a, v) => a + v.montant, 0);
        return `<tr><td><span class="name">${esc(l.nom)}</span><span class="sub">${esc(l.ticker)}</span></td><td class="r">${eur(l.investiTotal)}</td><td class="r">${eur(produit)}</td>
          <td class="r ${cls(l.realise)}">${eurS(l.realise)}</td><td class="r">${eur(l.dividendes)}</td><td>${d8(l.dateSortie)}</td></tr>`;
      }).join("")}</tbody>` : '<tbody><tr><td class="empty">Aucune ligne soldée.</td></tr></tbody>';

    if (state.view === "portefeuille") renderPortefeuilleCharts();
  }

  function renderPortefeuilleCharts() {
    if (!H) H = E.valueHistory(state.carnet.transactions, state.market, { today: today(), dividendes: P.dividendes.encaisses });
    let pts = H;
    if (state.histRange) pts = H.filter((p) => p.date >= E.addDays(today(), -state.histRange));
    // Échantillonnage hebdomadaire au-delà d'un an (lisibilité)
    if (pts.length > 400) pts = pts.filter((p, i) => i % 7 === 0 || i === pts.length - 1);
    const fmtX = (d, long) => (long ? d8(d) : `${MOIS_COURTS[+d.slice(5, 7) - 1]} ${d.slice(2, 4)}`);
    C.lineChart($("#chart-value"), pts.map((p) => p.date), [
      { label: "Valeur (titres + liquidités)", color: C.css("--series-1"), values: pts.map((p) => p.valeur), fill: true },
      { label: "Versements cumulés", color: C.css("--series-2"), values: pts.map((p) => p.versements), dash: "5 4", width: 1.6 },
    ], { format: (v) => eur(v), formatAxis: (v) => NF0.format(v / 1000) + " k€", formatX: fmtX, label: "Valeur du portefeuille et versements",
      extra: (i) => { const p = pts[i]; const g = p.valeur - p.versements; return `<div>Écart : <span class="num ${cls(g)}">${eurS(g)}</span></div>`; } });

    const t = P.totaux;
    const items = P.lignes.filter((l) => l.valeur).map((l) => ({ nom: l.nom, v: l.valeur })).sort((a, b) => b.v - a.v);
    if (t.cash > 0.5) items.push({ nom: "Liquidités", v: t.cash, cash: true });
    const tot = items.reduce((s, x) => s + x.v, 0);
    $("#chart-alloc").innerHTML = items.length ? items.map((x) => `<div class="alloc-row"><span class="name" title="${esc(x.nom)}">${esc(x.nom)}</span>
      <span class="bar"><i style="width:${(x.v / items[0].v) * 100}%;${x.cash ? "background:var(--series-2)" : ""}"></i></span><span class="num">${pct(x.v / tot, 1)}</span></div>`).join("")
      : '<div class="empty">Rien à répartir.</div>';
  }

  // ------------------------------------------------------------------ carnet
  function resolveName(s) {
    const q = (s || "").trim().toLowerCase();
    if (!q) return null;
    return inst().find((i) => i.nom.toLowerCase() === q || i.ticker.toLowerCase() === q || (i.isin || "").toLowerCase() === q
      || (i.alias || []).some((a) => a.toLowerCase() === q) || (i.codeGoogle || "").toLowerCase() === q) || null;
  }
  const isFlux = (type) => E.TYPES_FLUX.includes(type);

  function updateFormLabels() {
    const type = $("#f-type").value;
    const flux = isFlux(type);
    $("#f-name-label").textContent = flux ? "Libellé" : "Ligne";
    $("#f-nom").placeholder = flux ? "ex. Perso" : "ex. Air Liquide";
    $("#f-nom").setAttribute("list", flux ? "dl-libelles" : "dl-instruments");
    $("#f-qty-wrap").hidden = flux;
    $("#f-price-label").textContent = flux ? "Montant (€)" : type === "Dividende" ? "Dividende par action (€)" : "Cours + frais (€)";
    $("#f-qty-wrap").firstChild.textContent = type === "Dividende" ? "Parts " : "Quantité ";
    updateFormTotal();
  }
  function readForm() {
    const type = $("#f-type").value;
    const flux = isFlux(type);
    const q = flux ? 1 : parseFloat(String($("#f-qty").value).replace(",", "."));
    const p = parseFloat(String($("#f-prix").value).replace(",", "."));
    const nom = $("#f-nom").value.trim();
    const tx = { id: state.editingId || "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      type, date: $("#f-date").value, quantite: q, prix: p, montant: isFinite(q * p) ? E.round2(q * p) : NaN };
    if (flux) tx.libelle = nom || "Perso";
    else { const i = resolveName(nom); tx.ticker = i ? i.ticker : null; tx._nom = nom; }
    return tx;
  }
  function updateFormTotal() {
    const tx = readForm();
    $("#f-total").textContent = isFinite(tx.montant) ? eur(tx.montant) : "—";
    let hint = "";
    if (tx.ticker) {
      const held = E.positionAt(state.carnet.transactions.filter((t) => t.id !== state.editingId), tx.ticker, tx.date || today());
      hint = `${qty(held)} part${held > 1 ? "s" : ""} détenue${held > 1 ? "s" : ""} à cette date`;
      if (tx.type === "Vente" && P) {
        const l = P.lignes.find((x) => x.ticker === tx.ticker);
        if (l && isFinite(tx.prix) && isFinite(tx.quantite)) hint += ` · plus-value estimée ${eurS(tx.quantite * (tx.prix - l.pru))}`;
      }
    }
    $("#f-hint").textContent = hint;
  }

  async function submitForm(ev) {
    ev.preventDefault();
    const tx = readForm();
    const errs = [];
    if (!isFlux(tx.type) && !tx.ticker && tx._nom) {
      showResolver(tx._nom);
      errs.push(`« ${tx._nom} » n'est pas dans le référentiel : ajoutez-la ci-dessous.`);
    } else {
      $("#resolver").hidden = true;
    }
    const others = state.carnet.transactions;
    if (!errs.length) errs.push(...E.validateTransaction(tx, others, inst(), today()));
    $("#f-errors").innerHTML = errs.map((e) => `<li>${esc(e)}</li>`).join("");
    for (const f of ["#f-qty", "#f-prix", "#f-date", "#f-nom"]) $(f).removeAttribute("aria-invalid");
    if (errs.length) {
      if (errs.some((e) => /quantité|parts/i.test(e))) $("#f-qty").setAttribute("aria-invalid", "true");
      if (errs.some((e) => /cours|montant/i.test(e))) $("#f-prix").setAttribute("aria-invalid", "true");
      if (errs.some((e) => /date/i.test(e))) $("#f-date").setAttribute("aria-invalid", "true");
      if (errs.some((e) => /référentiel/i.test(e))) $("#f-nom").setAttribute("aria-invalid", "true");
      return;
    }
    delete tx._nom;
    const list = state.carnet.transactions;
    if (state.editingId) {
      const k = list.findIndex((t) => t.id === state.editingId);
      list[k] = tx;
      toast("Ordre modifié");
    } else {
      list.push(tx);
      toast(`${tx.type} enregistré${tx.type === "Vente" || tx.type === "Apport" ? "e" : ""}`);
    }
    resetForm();
    await persist("carnet");
    recompute();
    renderAll();
  }

  function resetForm() {
    state.editingId = null;
    const f = $("#order-form");
    const type = $("#f-type").value;
    f.reset();
    $("#f-type").value = type;
    $("#f-date").value = today();
    $("#f-date").max = today();
    $("#form-title").textContent = "Nouvel ordre";
    $("#f-submit").textContent = "Ajouter l'ordre";
    $("#f-cancel").hidden = true;
    $("#f-errors").innerHTML = "";
    $("#resolver").hidden = true;
    updateFormLabels();
  }

  function editTx(id) {
    const t = state.carnet.transactions.find((x) => x.id === id);
    if (!t) return;
    state.editingId = id;
    $("#f-type").value = t.type;
    updateFormLabels();
    $("#f-nom").value = t.ticker ? nomDe(t.ticker) : t.libelle || "";
    $("#f-qty").value = t.quantite;
    $("#f-date").value = t.date;
    $("#f-prix").value = t.prix;
    $("#form-title").textContent = `Modifier l'ordre du ${d8(t.date)}`;
    $("#f-submit").textContent = "Enregistrer la modification";
    $("#f-cancel").hidden = false;
    updateFormTotal();
    renderCarnetTable();
    $("#order-form").scrollIntoView({ behavior: "smooth", block: "start" });
    $("#f-qty").focus({ preventScroll: true });
  }

  async function deleteTx(id) {
    const t = state.carnet.transactions.find((x) => x.id === id);
    if (!t) return;
    const label = `${t.type} · ${t.ticker ? nomDe(t.ticker) : t.libelle} · ${d8(t.date)} · ${eur(t.montant)}`;
    if (!confirm(`Supprimer cet ordre ?\n\n${label}`)) return;
    state.carnet.transactions = state.carnet.transactions.filter((x) => x.id !== id);
    if (state.editingId === id) resetForm();
    await persist("carnet");
    recompute();
    renderAll();
    toast("Ordre supprimé");
  }

  // Ajout d'une ligne inconnue au référentiel (recherche publique du ticker par nom ou ISIN)
  function showResolver(nom) {
    const r = $("#resolver");
    r.hidden = false;
    const isinGuess = /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(nom) ? nom.toUpperCase() : "";
    r.innerHTML = `<div><strong>Nouvelle ligne « ${esc(nom)} »</strong> — ${state.server ? "recherche du ticker en cours…" : "renseignez le ticker Yahoo (ex. RUI.PA)."}</div>
      <div class="cands"></div>
      <div class="row"><input id="r-nom" value="${esc(isinGuess ? "" : nom)}" placeholder="Nom affiché" aria-label="Nom affiché">
        <input id="r-ticker" placeholder="Ticker (ex. RUI.PA)" aria-label="Ticker">
        <input id="r-isin" value="${esc(isinGuess)}" placeholder="ISIN (facultatif)" aria-label="ISIN">
        <select id="r-type" aria-label="Type"><option value="action">Action</option><option value="etf">ETF</option></select>
        <select id="r-dist" aria-label="Distribution"><option value="distribuant">Distribuant</option><option value="capitalisant">Capitalisant</option></select>
        <button type="button" class="btn primary small" id="r-add">Ajouter au référentiel</button></div>`;
    $("#r-add").onclick = () => addInstrument();
    if (state.server) {
      fetchJSON("api/resolve?q=" + encodeURIComponent(nom)).then((list) => {
        const c = $(".cands", r);
        const sorted = list.sort((a, b) => (b.ticker.endsWith(".PA") ? 1 : 0) - (a.ticker.endsWith(".PA") ? 1 : 0));
        r.firstElementChild.innerHTML = `<strong>Nouvelle ligne « ${esc(nom)} »</strong> — ${sorted.length ? "choisissez la bonne cotation (Paris = .PA) :" : "aucun résultat, renseignez le ticker à la main."}`;
        c.innerHTML = sorted.slice(0, 6).map((x, k) => `<div class="row"><button type="button" class="btn small" data-k="${k}">Choisir</button>
          <span class="num">${esc(x.ticker)}</span> <span>${esc(x.nom || "")}</span> <span class="muted">${esc(x.place || "")} · ${esc(x.type || "")}</span></div>`).join("");
        $$("button[data-k]", c).forEach((b) => (b.onclick = () => {
          const x = sorted[+b.dataset.k];
          $("#r-ticker").value = x.ticker;
          if (!$("#r-nom").value) $("#r-nom").value = x.nom || x.ticker;
          $("#r-type").value = x.type === "ETF" ? "etf" : "action";
        }));
      }).catch(() => { r.firstElementChild.innerHTML = `<strong>Nouvelle ligne « ${esc(nom)} »</strong> — recherche indisponible, renseignez le ticker à la main.`; });
    }
  }
  async function addInstrument() {
    const nom = $("#r-nom").value.trim(), ticker = $("#r-ticker").value.trim().toUpperCase(), isin = $("#r-isin").value.trim().toUpperCase();
    if (!nom || !/^[A-Z0-9.\-^=]+$/.test(ticker)) { toast("Nom et ticker requis"); return; }
    if (instByTicker(ticker)) { toast("Ticker déjà présent dans le référentiel"); return; }
    const typed = $("#f-nom").value.trim();
    inst().push({ ticker, nom, isin, codeGoogle: "", type: $("#r-type").value, distribution: $("#r-dist").value,
      retenueSource: 0, alias: [...new Set([nom, typed].filter(Boolean))] });
    inst().sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
    await persist("instruments");
    $("#f-nom").value = nom;
    $("#resolver").hidden = true;
    $("#f-errors").innerHTML = "";
    renderCarnet();
    updateFormTotal();
    toast(`${nom} ajouté au référentiel`);
    refreshMarket(false); // récupérer cours et dividendes de la nouvelle ligne
  }

  function renderCarnet() {
    const txs = state.carnet.transactions;
    $("#dl-instruments").innerHTML = inst().map((i) => `<option value="${esc(i.nom)}">${esc(i.ticker)}</option>`).join("");
    let dl = $("#dl-libelles");
    if (!dl) { dl = document.createElement("datalist"); dl.id = "dl-libelles"; document.body.appendChild(dl); }
    dl.innerHTML = [...new Set(txs.filter((t) => t.libelle).map((t) => t.libelle))].map((l) => `<option value="${esc(l)}">`).join("");
    // Filtres
    const fill = (sel, values, all) => {
      const cur = sel.value;
      sel.innerHTML = `<option value="">${all}</option>` + values.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
      sel.value = values.some(([v]) => v === cur) ? cur : "";
    };
    fill($("#flt-type"), E.TYPES.map((t) => [t, t]), "Tous types");
    const tks = [...new Set(txs.map((t) => t.ticker).filter(Boolean))].sort((a, b) => nomDe(a).localeCompare(nomDe(b), "fr"));
    fill($("#flt-ligne"), tks.map((t) => [t, nomDe(t)]), "Toutes lignes");
    fill($("#flt-annee"), [...new Set(txs.map((t) => t.date.slice(0, 4)))].sort().reverse().map((y) => [y, y]), "Toutes années");
    renderCarnetTable();
    renderReferentiel();
  }

  function renderCarnetTable() {
    const ft = $("#flt-type").value, fl = $("#flt-ligne").value, fy = $("#flt-annee").value;
    const list = E.sortTransactions(state.carnet.transactions).reverse()
      .filter((t) => (!ft || t.type === ft) && (!fl || t.ticker === fl) && (!fy || t.date.startsWith(fy)));
    const typeTag = { Achat: "info", Vente: "err", Apport: "ok", Parrainage: "ok", Dividende: "est" };
    const total = list.reduce((s, t) => s + (t.montant || 0), 0);
    $("#tx-table").innerHTML = list.length ? `<thead><tr><th>Date</th><th>Type</th><th>Ligne / libellé</th><th class="r">Quantité</th><th class="r">Cours + frais</th><th class="r">Montant</th><th><span class="sr">Actions</span></th></tr></thead><tbody>${
      list.map((t) => `<tr class="${t.id === state.editingId ? "editing" : ""}"><td class="num">${d8(t.date)}</td><td><span class="tag ${typeTag[t.type] || "muted"}">${t.type}</span></td>
        <td>${t.ticker ? `<span class="name">${esc(nomDe(t.ticker))}</span>` : esc(t.libelle || "")}</td>
        <td class="r">${isFlux(t.type) ? "" : qty(t.quantite)}</td><td class="r">${isFlux(t.type) ? "" : prix(t.prix)}</td><td class="r">${eur(t.montant)}</td>
        <td><button type="button" class="link" data-edit="${esc(t.id)}">Modifier</button> · <button type="button" class="link" data-del="${esc(t.id)}">Supprimer</button></td></tr>`).join("")
    }</tbody><tfoot><tr><td colspan="5">${list.length} ordre${list.length > 1 ? "s" : ""}${ft || fl || fy ? " (filtrés)" : ""}</td><td class="r">${ft ? eur(total) : ""}</td><td></td></tr></tfoot>`
      : '<tbody><tr><td class="empty">Aucun ordre ne correspond aux filtres.</td></tr></tbody>';
  }

  function renderReferentiel() {
    const used = new Set(state.carnet.transactions.map((t) => t.ticker));
    $("#ref-table").innerHTML = `<thead><tr><th>Ligne</th><th>Ticker</th><th>ISIN</th><th>Type</th><th>Distribution</th><th class="r">Retenue à la source</th><th></th></tr></thead><tbody>${
      inst().map((i) => `<tr><td class="name">${esc(i.nom)}</td><td class="num">${esc(i.ticker)}</td>
        <td><input class="ref-input" data-ref="${esc(i.ticker)}" data-field="isin" value="${esc(i.isin || "")}" placeholder="à compléter" aria-label="ISIN de ${esc(i.nom)}"></td>
        <td>${i.type === "etf" ? "ETF" : "Action"}</td>
        <td><select class="ref-input" data-ref="${esc(i.ticker)}" data-field="distribution" aria-label="Distribution de ${esc(i.nom)}">
          <option value="distribuant" ${i.distribution !== "capitalisant" ? "selected" : ""}>Distribuant</option><option value="capitalisant" ${i.distribution === "capitalisant" ? "selected" : ""}>Capitalisant</option></select></td>
        <td class="r"><input class="ref-input pct" type="number" min="0" max="100" step="0.1" data-ref="${esc(i.ticker)}" data-field="retenueSource" value="${NF1.format((i.retenueSource || 0) * 100).replace(",", ".")}" aria-label="Retenue à la source en % pour ${esc(i.nom)}"> %</td>
        <td>${used.has(i.ticker) ? "" : `<button type="button" class="link" data-delref="${esc(i.ticker)}">Retirer</button>`}</td></tr>`).join("")}</tbody>`;
  }

  // -------------------------------------------------------------- dividendes
  function renderDividendes() {
    const agg = P.dividendes.aggregate;
    const years = agg.years.length ? agg.years : [today().slice(0, 4)];
    const up = upcoming();
    const t = P.totaux;

    // À venir
    const next = up[0];
    const total12 = up.filter((e) => e.datePaiement <= E.addDays(today(), 365)).reduce((s, e) => s + e.montant, 0);
    const parLigne = {};
    for (const e of up) if (e.fiabilite !== "détaché") parLigne[e.ticker] = (parLigne[e.ticker] || 0) + e.montant;
    const byMonth = new Map();
    for (const e of up) {
      const k = e.datePaiement.slice(0, 7);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(e);
    }
    const nextHTML = next ? `<div class="next-box"><div class="muted">Prochain versement</div>
        <div class="big">${eur(next.montant)}</div>
        <div><strong>${esc(nomDe(next.ticker))}</strong> ${tagFiab(next.fiabilite)}</div>
        <div class="countdown">dans ${E.daysBetween(today(), next.datePaiement)} jour${E.daysBetween(today(), next.datePaiement) > 1 ? "s" : ""}</div>
        <div class="muted">Détachement ${d8(next.exDate)} · versement ~${d8(next.datePaiement)}<br>${qty(next.parts)} parts × ${prix(next.parAction)}</div>
        <hr style="border:0;border-top:1px solid var(--border);width:100%">
        <div class="muted">Attendu sur 12 mois <span class="tag est">estimé</span></div><div class="big" style="font-size:20px">${eur(total12)}</div>
        <div class="muted">Rendement sur coût : <span class="num">${pct(F.total / t.coutRevient)}</span><br>Rendement sur cours : <span class="num">${pct(F.total / t.valeurTitres)}</span></div>
      </div>` : '<div class="next-box"><div class="muted">Aucun dividende attendu : aucune ligne distribuante détenue.</div></div>';
    const cal = [...byMonth.entries()].map(([k, evs]) => {
      const [y, m] = k.split("-");
      const s = evs.reduce((a, e) => a + e.montant, 0);
      return `<div class="cal-month"><div class="m">${MOIS[+m - 1]} ${y}</div><ul>${evs.map((e) => `<li><span class="d">${d8(e.datePaiement)}</span> <span>${esc(nomDe(e.ticker))}</span> <span class="num">${eur(e.montant)}</span> ${tagFiab(e.fiabilite)}</li>`).join("")}</ul><div class="num"><strong>${eur(s)}</strong></div></div>`;
    }).join("");
    const yoc = P.lignes.filter((l) => parLigne[l.ticker]).sort((a, b) => parLigne[b.ticker] - parLigne[a.ticker]);
    const yocTable = yoc.length ? `<div class="table-wrap" style="margin-top:12px"><table class="data compact"><thead><tr><th>Ligne</th><th class="r">Dividende annuel estimé</th><th class="r">Rendement sur coût</th><th class="r">Rendement sur cours</th></tr></thead><tbody>${
      yoc.map((l) => `<tr><td>${esc(l.nom)}</td><td class="r">${eur(parLigne[l.ticker])}</td><td class="r">${pct(parLigne[l.ticker] / l.cout)}</td><td class="r">${pct(l.valeur ? parLigne[l.ticker] / l.valeur : null)}</td></tr>`).join("")}</tbody></table></div>` : "";
    $("#upcoming").innerHTML = nextHTML + `<div><div class="cal">${cal || '<div class="empty">Rien de prévu dans les 12 prochains mois.</div>'}</div>${yocTable}</div>`;

    // Tableau mois × années
    const cur = today().slice(0, 4);
    $("#div-month-table").innerHTML = `<thead><tr><th>Mois</th>${years.map((y) => `<th class="r">${y}</th>`).join("")}</tr></thead><tbody>${
      MOIS.map((m, i) => `<tr><td>${m}</td>${years.map((y) => { const v = (agg.byYearMonth[y] || [])[i] || 0; return `<td class="r ${v ? "" : "zero"}">${v ? eur(v) : "—"}</td>`; }).join("")}</tr>`).join("")
    }</tbody><tfoot><tr><td>Total</td>${years.map((y) => `<td class="r">${eur(agg.byYear[y] || 0)}</td>`).join("")}</tr>
      <tr><td>Moyenne mensuelle</td>${years.map((y) => `<td class="r">${eur((agg.byYear[y] || 0) / 12)}</td>`).join("")}</tr>
      ${years.includes(cur) ? `<tr><td>Attendus d'ici fin ${cur} <span class="tag est">estimé</span></td>${years.map((y) => `<td class="r">${y === cur ? eur(up.filter((e) => e.datePaiement.startsWith(cur)).reduce((s, e) => s + e.montant, 0)) : ""}</td>`).join("")}</tr>` : ""}</tfoot>`;

    // Détail par ligne
    const ysel = $("#div-year");
    if (!state.divYear || !years.includes(state.divYear)) state.divYear = years[years.length - 1];
    ysel.innerHTML = years.slice().reverse().map((y) => `<option ${y === state.divYear ? "selected" : ""}>${y}</option>`).join("");
    const det = agg.byTickerYearMonth[state.divYear] || {};
    const tks = Object.keys(det).sort((a, b) => nomDe(a).localeCompare(nomDe(b), "fr"));
    const monthTot = Array(12).fill(0);
    $("#div-detail-table").innerHTML = tks.length ? `<thead><tr><th>Ligne</th>${MOIS_COURTS.map((m) => `<th class="r">${m}</th>`).join("")}<th class="r">Total</th></tr></thead><tbody>${
      tks.map((tk) => { const row = det[tk]; row.forEach((v, i) => (monthTot[i] += v));
        return `<tr><td>${esc(nomDe(tk))}</td>${row.map((v) => `<td class="r ${v ? "" : "zero"}">${v ? NF2.format(v) : "—"}</td>`).join("")}<td class="r"><strong>${eur(row.reduce((a, b) => a + b, 0))}</strong></td></tr>`; }).join("")
    }</tbody><tfoot><tr><td>Total</td>${monthTot.map((v) => `<td class="r">${v ? NF2.format(v) : "—"}</td>`).join("")}<td class="r">${eur(agg.byYear[state.divYear] || 0)}</td></tr></tfoot>`
      : '<tbody><tr><td class="empty">Aucun dividende cette année.</td></tr></tbody>';

    // Rapprochement
    const recs = P.dividendes.records.filter((r) => !r.aVenir);
    const flagged = (r) => r.source !== "rapproché" || (r.ecart !== null && Math.abs(r.ecart) > 1) || r.explication;
    const nRap = recs.filter((r) => r.source === "rapproché" && Math.abs(r.ecart) <= 1).length;
    const nEc = recs.filter((r) => r.source === "rapproché" && Math.abs(r.ecart) > 1).length;
    const nCalc = recs.filter((r) => r.source === "calculé").length;
    const nSaisi = recs.filter((r) => r.source === "saisi").length;
    $("#rec-summary").innerHTML = `${nRap} versement${nRap > 1 ? "s" : ""} du carnet retrouvé${nRap > 1 ? "s" : ""} par le calcul à moins de 1 € près · `
      + `${nEc} écart${nEc > 1 ? "s" : ""} &gt; 1 € · ${nSaisi} saisie${nSaisi > 1 ? "s" : ""} sans détachement correspondant · ${nCalc} calculé${nCalc > 1 ? "s" : ""} absent${nCalc > 1 ? "s" : ""} du carnet (compté${nCalc > 1 ? "s" : ""} dans les totaux). `
      + `Les saisies du carnet font foi. Décalage détachement → crédit : ${P.dividendes.decalageDefaut} jours ouvrés en général (calibré sur le carnet).`;
    const shown = (state.recOnly ? recs.filter(flagged) : recs).slice().reverse();
    $("#rec-only").checked = state.recOnly;
    const srcTag = { "rapproché": '<span class="tag ok">rapproché</span>', "saisi": '<span class="tag muted">saisi seul</span>', "calculé": '<span class="tag info">calculé seul</span>' };
    $("#rec-table").innerHTML = shown.length ? `<thead><tr><th>Versement</th><th>Ligne</th><th>Détachement</th><th class="r">Parts</th><th class="r">€ / action</th><th class="r">Calculé</th><th class="r">Saisi</th><th class="r">Écart</th><th>Source</th><th>Explication</th></tr></thead><tbody>${
      shown.map((r) => `<tr class="${r.ecart !== null && Math.abs(r.ecart) > 1 ? "flag" : ""}"><td class="num">${d8(r.datePaiement)}${r.datePaiementEstimee ? "*" : ""}</td><td>${esc(nomDe(r.ticker))}</td>
        <td class="num">${r.exDate ? d8(r.exDate) : "—"}</td><td class="r">${qty(r.parts)}</td><td class="r">${prix(r.parAction)}</td>
        <td class="r">${r.montantCalcule === null ? "—" : eur(r.montantCalcule)}</td><td class="r">${r.montantSaisi === null ? "—" : eur(r.montantSaisi)}</td>
        <td class="r ${r.ecart && Math.abs(r.ecart) > 1 ? "neg" : ""}">${r.ecart === null ? "—" : eurS(r.ecart)}</td><td>${srcTag[r.source]}</td><td>${esc(r.explication || "")}</td></tr>`).join("")
    }</tbody>` : '<tbody><tr><td class="empty">Aucun écart : chaque dividende saisi correspond au calcul.</td></tr></tbody>';

    if (state.view === "dividendes") renderDividendesChart(years);
  }

  function renderDividendesChart(years) {
    const agg = P.dividendes.aggregate;
    const palette = ["--series-2", "--series-3", "--series-4", "--series-1"];
    const ys = years.slice(-4);
    C.barChart($("#chart-div"), MOIS_COURTS.map((m) => m.replace(".", "")), ys.map((y, k) => ({
      label: y, color: C.css(palette[(k + 4 - ys.length) % 4]), values: (agg.byYearMonth[y] || Array(12).fill(0)),
    })), { format: (v) => eur(v), formatAxis: (v) => NF0.format(v) + " €", catLabel: (i) => MOIS[i], label: "Dividendes par mois et par année" });
  }

  // --------------------------------------------------------------- exports
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const stamp = () => today();

  function exportJSON() {
    const o = { format: "suivi-pea", profil: state.profil.id, exportedAt: new Date().toISOString(), carnet: state.carnet, instruments: state.instruments };
    download(`suivi-pea-${state.profil.id}-sauvegarde-${stamp()}.json`, new Blob([JSON.stringify(o, null, 1)], { type: "application/json" }));
  }
  function exportCSV() {
    const n = (v) => String(v).replace(".", ",");
    const rows = [["Transaction", "Nom", "Ticker", "Quantité", "Date", "Cours + Frais en €", "Montant Total en €", "Mois", "Année"]];
    for (const t of E.sortTransactions(state.carnet.transactions))
      rows.push([t.type, t.ticker ? nomDe(t.ticker) : t.libelle, t.ticker || "", n(t.quantite), d8(t.date), n(t.prix), n(t.montant), +t.date.slice(5, 7), t.date.slice(0, 4)]);
    const csv = "﻿" + rows.map((r) => r.map((c) => (/[;"\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(";")).join("\r\n");
    download(`carnet-ordres-${stamp()}.csv`, new Blob([csv], { type: "text/csv;charset=utf-8" }));
  }
  function exportXLSX() {
    const X = window.PEAXlsx;
    const e = (v) => ({ v: E.round2(v), f: "eur" }), d = (s) => (s ? { v: s, f: "date" } : ""), p = (v) => (v === null ? "" : { v, f: "pct" });
    const t = P.totaux;
    const carnet = [["Transaction", "Nom", "Ticker", "Quantité", "Date", "Cours + Frais (€)", "Montant total (€)", "Mois", "Année"],
      ...E.sortTransactions(state.carnet.transactions).map((x) => [x.type, x.ticker ? nomDe(x.ticker) : x.libelle, x.ticker || "", x.quantite, d(x.date),
        { v: x.prix, f: "eur" }, e(x.montant), +x.date.slice(5, 7), +x.date.slice(0, 4)])];
    const pf = [["Ligne", "ISIN", "Ticker", "Parts", "PRU", "Cours", "Valeur", "Gain/perte (€)", "Gain/perte (%)", "Poids"],
      ...P.lignes.map((l) => [l.nom, l.isin, l.ticker, l.quantite, e(l.pru), l.cours === null ? "indisponible" : e(l.cours), l.valeur === null ? "" : e(l.valeur),
        l.plusValue === null ? "" : e(l.plusValue), p(l.plusValuePct), p(l.poids)]),
      [], [{ v: "Synthèse", b: true }],
      ["Valeur des titres", e(t.valeurTitres)], ["Liquidités", e(t.cash)], ["Versements (apports + parrainages)", e(t.versements)],
      ["Coût de revient", e(t.coutRevient)], ["Plus-value latente", e(t.plusValueLatente), p(t.plusValueLatentePct)],
      ["Plus-values réalisées", e(t.plusValuesRealisees)], ["Dividendes encaissés", e(t.dividendesCumules)],
      ["Performance totale", e(t.performanceTotale)], ["Rendement simple sur versements", p(t.rendementSimple)],
      ["Cours du", marketInfo().last ? fmtDateTime(marketInfo().last) : "indisponible"]];
    const soldees = [["Ligne", "Ticker", "Investi", "Produit des ventes", "Plus-value réalisée", "Dividendes perçus", "Sortie"],
      ...P.soldees.map((l) => [l.nom, l.ticker, e(l.investiTotal), e(l.ventes.reduce((a, v) => a + v.montant, 0)), e(l.realise), e(l.dividendes), d(l.dateSortie)])];
    const agg = P.dividendes.aggregate;
    const divMois = [["Mois", ...agg.years.map(Number)], ...MOIS.map((m, i) => [m, ...agg.years.map((y) => e(agg.byYearMonth[y][i]))]),
      [{ v: "Total", b: true }, ...agg.years.map((y) => ({ v: agg.byYear[y], f: "eur", b: true }))], ["Moyenne mensuelle", ...agg.years.map((y) => e(agg.byYear[y] / 12))]];
    const divDet = [["Versement", "Ligne", "Ticker", "Détachement", "Parts", "€ / action", "Montant", "Calculé", "Saisi", "Écart", "Source", "Explication"],
      ...P.dividendes.records.filter((r) => !r.aVenir).map((r) => [d(r.datePaiement), nomDe(r.ticker), r.ticker, d(r.exDate), r.parts, { v: r.parAction, f: "num" },
        e(r.montant), r.montantCalcule === null ? "" : e(r.montantCalcule), r.montantSaisi === null ? "" : e(r.montantSaisi), r.ecart === null ? "" : e(r.ecart), r.source, r.explication || ""])];
    const aVenir = [["Versement estimé", "Ligne", "Détachement", "Parts", "€ / action (estimé)", "Montant estimé", "Fiabilité"],
      ...upcoming().map((x) => [d(x.datePaiement), nomDe(x.ticker), d(x.exDate), x.parts, { v: x.parAction, f: "num" }, e(x.montant), x.fiabilite])];
    const ref = [["Ligne", "Ticker", "ISIN", "Type", "Distribution", "Retenue à la source"],
      ...inst().map((i) => [i.nom, i.ticker, i.isin || "", i.type, i.distribution, p(i.retenueSource || 0)])];
    const blob = X.build([
      { name: "Carnet d'ordres", rows: carnet, widths: [12, 26, 10, 10, 12, 16, 18, 7, 7] },
      { name: "Portefeuille", rows: pf, widths: [34, 15, 10, 10, 13, 13, 14, 15, 14, 9] },
      { name: "Lignes soldées", rows: soldees, widths: [28, 10, 14, 18, 18, 16, 12] },
      { name: "Dividendes", rows: divMois, widths: [20, ...agg.years.map(() => 13)] },
      { name: "Dividendes détail", rows: divDet, widths: [12, 22, 10, 12, 7, 11, 12, 12, 12, 10, 11, 60] },
      { name: "Dividendes à venir", rows: aVenir, widths: [16, 22, 12, 7, 16, 15, 15] },
      { name: "Référentiel", rows: ref, widths: [28, 10, 15, 8, 13, 18] },
    ]);
    download(`suivi-pea-${stamp()}.xlsx`, blob);
  }
  async function importJSON(file) {
    try {
      const o = JSON.parse(await file.text());
      const carnet = o.carnet || (o.transactions ? o : null);
      if (!carnet || !Array.isArray(carnet.transactions)) throw new Error("fichier non reconnu");
      if (!confirm(`Remplacer le carnet de ${state.profil.nom} (${state.carnet.transactions.length} ordres) par cette sauvegarde (${carnet.transactions.length} ordres) ?`)) return;
      state.carnet = carnet;
      await persist("carnet");
      if (o.instruments && Array.isArray(o.instruments.instruments)) { state.instruments = o.instruments; await persist("instruments"); }
      recompute();
      renderAll();
      toast("Sauvegarde restaurée");
    } catch (e) {
      alert("Import impossible : " + e.message);
    }
  }

  // ------------------------------------------------------------- navigation
  function showView(v) {
    state.view = v;
    for (const b of $$(".tabs [role=tab]")) {
      const on = b.id === "tab-" + v;
      b.setAttribute("aria-selected", on);
      b.tabIndex = on ? 0 : -1;
      $("#" + b.getAttribute("aria-controls")).hidden = !on;
    }
    if (location.hash !== "#" + v) history.replaceState(null, "", "#" + v);
    if (v === "portefeuille") renderPortefeuilleCharts();
    if (v === "dividendes") renderDividendesChart(P.dividendes.aggregate.years.length ? P.dividendes.aggregate.years : [today().slice(0, 4)]);
  }

  let toastTimer;
  function toast(msg) {
    let t = $(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  function bind() {
    $$(".tabs [role=tab]").forEach((b) => b.addEventListener("click", () => showView(b.id.slice(4))));
    $(".tabs").addEventListener("keydown", (ev) => {
      if (!["ArrowLeft", "ArrowRight"].includes(ev.key)) return;
      const tabs = $$(".tabs [role=tab]");
      const k = tabs.findIndex((b) => b.getAttribute("aria-selected") === "true");
      const n = tabs[(k + (ev.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      n.focus(); showView(n.id.slice(4));
    });
    $("#pf-table").addEventListener("click", (ev) => {
      const th = ev.target.closest("th[data-key]");
      if (!th) return;
      const k = th.dataset.key;
      state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : k === "nom" || k === "isin" ? 1 : -1 };
      savePrefs();
      renderPortefeuille();
    });
    $("#pf-table").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.matches("th[data-key]")) ev.target.click(); });
    $("#hist-range").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-range]");
      if (!b) return;
      state.histRange = +b.dataset.range;
      $$("#hist-range button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      renderPortefeuilleCharts();
    });
    $("#opt-xirr").addEventListener("change", (ev) => { state.xirr = ev.target.checked; savePrefs(); renderPortefeuille(); });
    $("#rec-only").addEventListener("change", (ev) => { state.recOnly = ev.target.checked; savePrefs(); renderDividendes(); });
    $("#div-year").addEventListener("change", (ev) => { state.divYear = ev.target.value; renderDividendes(); });
    $("#order-form").addEventListener("submit", submitForm);
    $("#f-type").addEventListener("change", updateFormLabels);
    for (const id of ["#f-qty", "#f-prix", "#f-date", "#f-nom"]) $(id).addEventListener("input", updateFormTotal);
    $("#f-cancel").addEventListener("click", () => { resetForm(); renderCarnetTable(); });
    for (const id of ["#flt-type", "#flt-ligne", "#flt-annee"]) $(id).addEventListener("change", renderCarnetTable);
    $("#tx-table").addEventListener("click", (ev) => {
      const e = ev.target.closest("[data-edit]"), d = ev.target.closest("[data-del]");
      if (e) editTx(e.dataset.edit);
      if (d) deleteTx(d.dataset.del);
    });
    $("#ref-table").addEventListener("change", async (ev) => {
      const el = ev.target.closest("[data-ref]");
      if (!el) return;
      const i = instByTicker(el.dataset.ref);
      if (el.dataset.field === "isin") {
        const v = el.value.trim().toUpperCase();
        if (v && !/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(v)) { toast("ISIN invalide (12 caractères)"); el.value = i.isin || ""; return; }
        i.isin = v;
      } else if (el.dataset.field === "retenueSource") {
        const v = parseFloat(el.value);
        i.retenueSource = isFinite(v) ? Math.min(100, Math.max(0, v)) / 100 : 0;
      } else i[el.dataset.field] = el.value;
      await persist("instruments");
      recompute();
      renderAll();
    });
    $("#ref-table").addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-delref]");
      if (!b || !confirm(`Retirer ${b.dataset.delref} du référentiel ?`)) return;
      state.instruments.instruments = inst().filter((i) => i.ticker !== b.dataset.delref);
      await persist("instruments");
      renderCarnet();
    });
    $("#btn-refresh").addEventListener("click", () => refreshMarket(true));
    $("#r-montant").addEventListener("input", (ev) => {
      const v = parseFloat(ev.target.value);
      state.retraitMontant = isFinite(v) ? v : null;
      renderRetrait();
    });
    $("#p-ouverture").addEventListener("change", async (ev) => {
      const v = ev.target.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v > today()) return;
      params().dateOuverturePEA = v;
      await persist("carnet");
      renderAll();
    });
    for (const sel of ["#p-frais-taux", "#p-frais-min"]) $(sel).addEventListener("change", async () => {
      const taux = parseFloat($("#p-frais-taux").value), minimum = parseFloat($("#p-frais-min").value);
      if (!(taux >= 0) || !(minimum >= 0)) return;
      params().frais = { taux: taux / 100, minimum };
      await persist("carnet");
      recompute();
      renderAll();
    });
    $("#profil").addEventListener("change", (ev) => {
      LS.set("pea.profil", ev.target.value);
      // Tout l'état dépend du carnet : on repart d'une page propre. Sans ?profil= dans l'adresse, un
      // location.replace vers la même URL (avec #onglet) ne serait qu'un saut d'ancre : il faut reload().
      const u = new URL(location.href);
      if (!u.searchParams.has("profil")) return location.reload();
      u.searchParams.delete("profil");
      location.replace(u);
    });
    $("#btn-theme").addEventListener("click", () => {
      const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("pea.theme", next); } catch { /* sans stockage : le thème n'est pas mémorisé */ }
      renderAll();
      showView(state.view);
    });
    $(".menu-panel").addEventListener("click", (ev) => {
      const a = ev.target.closest("[data-action]");
      if (!a) return;
      ({ "export-xlsx": exportXLSX, "export-csv": exportCSV, "export-json": exportJSON })[a.dataset.action]();
      $(".menu").open = false;
    });
    $("#import-json").addEventListener("change", (ev) => { if (ev.target.files[0]) importJSON(ev.target.files[0]); ev.target.value = ""; $(".menu").open = false; });
    document.addEventListener("click", (ev) => { if (!ev.target.closest(".menu")) $(".menu").open = false; });
    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => showView(state.view), 150); });
    window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (["portefeuille", "carnet", "dividendes"].includes(v)) showView(v); });
  }

  async function init() {
    bind();
    await load();
    const sel = $("#profil");
    sel.innerHTML = state.profils.map((p) => `<option value="${esc(p.id)}">${esc(p.nom)}</option>`).join("");
    sel.value = state.profil.id;
    sel.hidden = state.profils.length < 2;
    document.title = `Suivi PEA — ${state.profil.nom}`;
    recompute();
    resetForm();
    renderAll();
    const v = location.hash.slice(1);
    showView(["portefeuille", "carnet", "dividendes"].includes(v) ? v : "portefeuille");
    // Cours du jour : si le serveur local tourne et que les données ont plus de 15 minutes, on les actualise.
    const gen = state.market.generatedAt ? Date.parse(state.market.generatedAt) : 0;
    if (state.server && Date.now() - gen > 15 * 60000) refreshMarket(false);
  }

  init().catch((e) => {
    console.error(e);
    const b = $("#banner");
    b.hidden = false;
    b.className = "banner err";
    b.textContent = "Erreur au démarrage : " + e.message;
  });
})();
