#!/usr/bin/env python3
"""Migration unique : classeur Excel du PEA -> data/carnet.json + data/instruments.json.

Bibliothèque standard uniquement (zipfile + ElementTree) : rien à installer.
Le fichier source n'est ouvert qu'en lecture.

Produit aussi data/excel-reference.json : les valeurs calculées par le classeur
(parts, PRU, totaux de dividendes...) qui servent de jeu de non-régression aux tests.

Usage : python3 scripts/import-excel.py [source/Fichier_suivi_PEA.xlsx] [--force]
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "rel": "http://schemas.openxmlformats.org/package/2006/relationships"}

# Référentiel public : nom affiché, type, politique de distribution.
# Les ETF capitalisants ne versent rien : ce n'est pas une erreur.
META = {
    "ABCA": ("ABC Arbitrage", "action", "distribuant"),
    "AI": ("Air Liquide", "action", "distribuant"),
    "CS": ("Axa", "action", "distribuant"),
    "BNP": ("BNP Paribas", "action", "distribuant"),
    "KER": ("Kering", "action", "distribuant"),
    "MC": ("LVMH", "action", "distribuant"),
    "OR": ("L'Oréal", "action", "distribuant"),
    "RUI": ("Rubis", "action", "distribuant"),
    "SU": ("Schneider Electric", "action", "distribuant"),
    "TTE": ("TotalEnergies", "action", "distribuant"),
    "CW8": ("ETF Amundi MSCI World", "etf", "capitalisant"),
    "EWLD": ("ETF Amundi MSCI World D", "etf", "distribuant"),
    "PSP5": ("ETF Amundi S&P500", "etf", "capitalisant"),
    "ESE": ("ETF BNP S&P500", "etf", "capitalisant"),
    "LQQ": ("ETF Nasdaq Lev 2", "etf", "capitalisant"),
    "TNO": ("ETF EuroStoxx600 Tech", "etf", "capitalisant"),
}
MOIS = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août",
        "Septembre", "Octobre", "Novembre", "Décembre"]


class Workbook:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.strings = []
        if "xl/sharedStrings.xml" in self.z.namelist():
            for si in ET.fromstring(self.z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                self.strings.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        wb = ET.fromstring(self.z.read("xl/workbook.xml"))
        rels = ET.fromstring(self.z.read("xl/_rels/workbook.xml.rels"))
        targets = {r.get("Id"): r.get("Target") for r in rels.findall("rel:Relationship", NS)}
        self.sheets = {}
        for s in wb.find("m:sheets", NS):
            t = targets[s.get(f"{{{NS['r']}}}id")].lstrip("/")
            self.sheets[s.get("name")] = t if t.startswith("xl/") else "xl/" + t

    def sheet(self, name):
        """Retourne {"C6": valeur} avec les valeurs mises en cache par Excel."""
        cells = {}
        root = ET.fromstring(self.z.read(self.sheets[name]))
        for c in root.iter(f"{{{NS['m']}}}c"):
            t, v = c.get("t"), c.find("m:v", NS)
            if t == "inlineStr":
                cells[c.get("r")] = "".join(x.text or "" for x in c.iter(f"{{{NS['m']}}}t"))
            elif v is None:
                continue
            elif t == "s":
                cells[c.get("r")] = self.strings[int(v.text)]
            elif t in ("str", "e"):
                cells[c.get("r")] = v.text
            elif t == "b":
                cells[c.get("r")] = v.text == "1"
            else:
                f = float(v.text)
                cells[c.get("r")] = int(f) if f.is_integer() else f
        return cells


def excel_date(serial):
    return (date(1899, 12, 30) + timedelta(days=int(serial))).isoformat()


def num(v):
    """Les cours du classeur sont parfois du texte « 170,44 »."""
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str) and v.strip() not in ("", "-"):
        return float(v.strip().replace(" ", "").replace(" ", "").replace(",", "."))
    return None


def clean_isin(v):
    v = re.sub(r"\s+", "", v or "").upper()
    return v if re.fullmatch(r"[A-Z]{2}[A-Z0-9]{9}[0-9]", v) else ""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    src = Path(args[0]) if args else ROOT / "source" / "Fichier_suivi_PEA.xlsx"
    if (DATA / "carnet.json").exists() and "--force" not in sys.argv:
        sys.exit("data/carnet.json existe déjà : relancer avec --force pour l'écraser "
                 "(une copie datée sera conservée).")
    wb = Workbook(src)
    DATA.mkdir(exist_ok=True)

    # --- Référentiel -------------------------------------------------------
    base = wb.sheet("Base de Données")
    name_to_ticker, instruments = {}, []
    for r in range(3, 40):
        nom, code = base.get(f"A{r}"), base.get(f"C{r}")
        if not nom or not isinstance(code, str) or ":" not in code:
            continue
        sym = code.split(":")[1].strip().upper()
        ticker = f"{sym}.PA"
        name_to_ticker[nom.strip()] = ticker
        disp, kind, dist = META.get(sym, (nom.strip(), "action", "distribuant"))
        instruments.append({
            "ticker": ticker, "nom": disp, "isin": clean_isin(base.get(f"B{r}")),
            "codeGoogle": code.strip(), "type": kind, "distribution": dist,
            "retenueSource": 0, "alias": sorted({nom.strip(), disp}),
        })
    instruments.sort(key=lambda i: i["nom"].lower())

    # --- Carnet d'ordres ---------------------------------------------------
    tr = wb.sheet("Transaction")
    txs, ignored = [], []
    for r in range(6, 600):
        typ = tr.get(f"C{r}")
        if not isinstance(typ, str) or typ.strip() in ("", "-"):
            continue
        typ = typ.strip()
        nom = str(tr.get(f"D{r}", "")).strip()
        qty, prix, d = num(tr.get(f"F{r}")), num(tr.get(f"H{r}")), tr.get(f"G{r}")
        if qty is None or prix is None or not isinstance(d, (int, float)):
            ignored.append(r)
            continue
        tx = {"id": f"x{r:04d}", "type": typ, "date": excel_date(d), "quantite": qty,
              "prix": round(prix, 6), "montant": round(num(tr.get(f"I{r}")) or qty * prix, 2)}
        if typ in ("Apport", "Parrainage"):
            tx["libelle"] = nom
        else:
            if nom not in name_to_ticker:
                sys.exit(f"Ligne {r} : instrument inconnu « {nom} »")
            tx["ticker"] = name_to_ticker[nom]
        txs.append(tx)

    # --- Valeurs de référence calculées par Excel (non-régression) ---------
    pf = wb.sheet("Portefeuille")
    ref_lines = []
    for r in range(10, 40):
        nom = pf.get(f"C{r}")
        if not nom or nom not in name_to_ticker:
            continue
        ref_lines.append({"ticker": name_to_ticker[nom], "nom": nom, "parts": pf.get(f"E{r}"),
                          "pru": num(pf.get(f"F{r}")), "cours": num(pf.get(f"G{r}"))})
    dv = wb.sheet("Dividendes")
    years = {}
    for col in "IJKLMNOP":
        y = dv.get(f"{col}5")
        if isinstance(y, int):
            years[col] = y
    div_month = {str(y): {str(m + 1): num(dv.get(f"{c}{6 + m}")) or 0 for m in range(12)}
                 for c, y in years.items()}
    div_year = {str(y): num(dv.get(f"{c}18")) or 0 for c, y in years.items()}
    reference = {
        "_note": "Valeurs mises en cache par Excel dans le classeur source (jeu de non-régression).",
        "valeurPortefeuille": pf.get("D5"), "versements": pf.get("D6"),
        "dividendesReinvestis": pf.get("D7"), "plusValueLatente": pf.get("H5"),
        "lignes": ref_lines, "dividendesParAnnee": div_year, "dividendesParMois": div_month,
    }

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if (DATA / "carnet.json").exists():
        backup = DATA / "backups"
        backup.mkdir(exist_ok=True)
        (backup / f"carnet-avant-import-{now[:19].replace(':', '')}.json").write_bytes(
            (DATA / "carnet.json").read_bytes())
    carnet = {"version": 1, "updatedAt": now, "transactions": txs}
    ref = {"version": 1, "updatedAt": now, "instruments": instruments}
    write(DATA / "carnet.json", carnet, "PEA_CARNET")
    write(DATA / "instruments.json", ref, "PEA_INSTRUMENTS")
    (DATA / "excel-reference.json").write_text(json.dumps(reference, ensure_ascii=False, indent=1), "utf-8")

    counts = {}
    for t in txs:
        counts[t["type"]] = counts.get(t["type"], 0) + 1
    print(f"{len(txs)} ordres importés : " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    print(f"{len(instruments)} instruments ; ISIN manquants : "
          + (", ".join(i["nom"] for i in instruments if not i["isin"]) or "aucun"))
    if ignored:
        print(f"Lignes ignorées (incomplètes) : {ignored}")


def write(path, obj, var):
    """Écrit le JSON + un .js équivalent, chargeable par index.html ouvert en double-clic (file://)."""
    text = json.dumps(obj, ensure_ascii=False, indent=1)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text, "utf-8")
    tmp.replace(path)
    path.with_suffix(".js").write_text(f"window.{var} = {text};\n", "utf-8")


if __name__ == "__main__":
    main()
