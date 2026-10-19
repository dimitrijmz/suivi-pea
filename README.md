# Suivi PEA

Une application qui remplace ton fichier Excel de suivi du PEA. Elle tourne **uniquement sur ton ordinateur** : tes ordres, tes quantités et tes montants ne sont jamais envoyés sur Internet. Seuls les codes boursiers publics (ex. `AI.PA`) sortent pour récupérer les cours et les dividendes.

Tu ne saisis que tes ordres (achat, vente, apport). Le reste est calculé tout seul : cours du jour, valeur du portefeuille, plus-values, dividendes perçus par mois et par année, prochains dividendes.

---

## 1. Ce qu'il faut installer (une seule fois)

| Outil | Pourquoi | Où le trouver |
|---|---|---|
| **Node.js** (version 20 ou plus) | fait tourner l'application et récupère les cours | https://nodejs.org → bouton « LTS » |
| **Python 3** | importe ton fichier Excel (une seule fois) | https://www.python.org/downloads/ (sous Windows, coche **« Add python.exe to PATH »**) |
| **Git** (facultatif) | télécharger et mettre à jour l'application | https://git-scm.com |

Aucune autre bibliothèque à installer : pas de `npm install`, pas de `pip install`.

Pour vérifier, ouvre un terminal (Windows : touche Windows → tape `PowerShell`) et tape :

```
node -v
python --version
```

Chacune doit afficher un numéro de version. Sur Mac/Linux, utilise `python3` au lieu de `python`.

## 2. Télécharger l'application

Avec Git :

```
git clone https://github.com/dimitrijmz/suivi-pea.git
cd suivi-pea
```

Sans Git : sur la page GitHub, bouton vert **Code → Download ZIP**, puis décompresse le dossier et ouvre un terminal dedans (Windows : clic droit dans le dossier → « Ouvrir dans le terminal »).

## 3. Importer ton fichier Excel (une seule fois)

1. Crée un dossier `source` dans le dossier de l'application.
2. Copie ton classeur dedans, par exemple `source/Fichier suivi PEA Nicolas.xlsx`.
3. Lance :

```
python scripts/import-excel.py "source/Fichier suivi PEA Nicolas.xlsx"
```

Le script lit ton classeur sans le modifier et crée le dossier `data/` avec ton carnet d'ordres (`data/carnet.json`). Il doit afficher quelque chose comme `158 ordres importés`.

> Après cet import, c'est l'application qui fait foi. Tu n'as plus besoin de mettre l'Excel à jour. Pour refaire l'import de zéro, ajoute `--force` à la fin de la commande : l'ancien carnet est sauvegardé dans `data/backups/` avant d'être remplacé.

## 4. Récupérer les cours et les dividendes

```
node scripts/refresh-market.mjs
```

Il doit afficher `16/16 tickers à jour`. Cette commande va chercher les cours et l'historique des dividendes sur Yahoo Finance et les range dans `data/market.json`.

## 5. Ouvrir l'application

```
node scripts/serve.mjs --open
```

Le navigateur s'ouvre sur http://127.0.0.1:8765. Garde le terminal ouvert tant que tu utilises l'application, puis ferme-le (ou `Ctrl+C`) pour l'arrêter. Sur Mac/Linux, `./lancer.sh` fait la même chose.

Lancée de cette façon, l'application enregistre tes saisies directement dans `data/carnet.json`, avec une sauvegarde datée dans `data/backups/`.

> Tu peux aussi ouvrir `index.html` en double-cliquant dessus, sans serveur. Dans ce cas, tes nouvelles saisies restent dans le navigateur et pas dans `data/`. Pense alors à utiliser **Exporter / Sauvegarde complète**.

## 6. Utilisation au quotidien

- **Ajouter un ordre** : onglet **Carnet d'ordres**, formulaire en haut. Le nom se complète tout seul, la date du jour est préremplie et le montant se calcule.
- **Dividendes** : rien à saisir. Ils sont calculés à partir des parts que tu détenais à chaque date de détachement. Si tu saisis toi-même une ligne `Dividende`, elle remplace le calcul, et un écart de plus de 1 € est signalé.
- **Mettre les cours à jour** : relance `node scripts/refresh-market.mjs`, ou clique sur **Actualiser les cours** en haut de l'application (quand elle tourne avec le serveur, elle le fait aussi toute seule à l'ouverture).

### Mise à jour automatique des cours (facultatif)

Pour que les cours se mettent à jour seuls du lundi au vendredi à 18h15 :

- **Mac / Linux / Windows avec WSL** : `scripts/planifier.sh` (pour la retirer : `scripts/planifier.sh --supprimer`). Le journal est écrit dans `data/refresh.log`.
- **Windows sans WSL** : ouvre le Planificateur de tâches, crée une tâche de base « Suivi PEA - cours » qui se déclenche du lundi au vendredi à 18h15. Action : programme `node`, arguments `scripts/refresh-market.mjs`, « Commencer dans » = le dossier de l'application.

## 7. Sauvegarde et confidentialité

- Toutes tes données personnelles sont dans **`data/`** (et ton Excel dans `source/`). Ces deux dossiers sont exclus de Git (`.gitignore`) : ils ne partent jamais sur GitHub, même si tu fais un `git push`.
- **Sauvegarde ton dossier `data/`** de temps en temps (clé USB, disque externe, cloud perso…). C'est la seule chose à ne pas perdre.
- Pour récupérer une nouvelle version de l'application : `git pull` dans le dossier. Ton dossier `data/` n'est pas touché.

## 8. En cas de problème

| Symptôme | Solution |
|---|---|
| `node` ou `python` : « commande introuvable » | Réinstalle l'outil (et coche « Add to PATH » pour Python sous Windows), puis ouvre un **nouveau** terminal. |
| `data/carnet.json existe déjà` | L'import a déjà été fait. Ajoute `--force` pour le refaire. |
| « source de cours injoignable » | Pas d'Internet, ou Yahoo est momentanément indisponible. L'application affiche les derniers cours connus avec leur date. Réessaie plus tard. |
| Le port 8765 est déjà utilisé | `node scripts/serve.mjs --open --port 8766` |
| Vérifier que les calculs sont justes | `node --test tests/engine.test.mjs` : tous les tests doivent être `pass`. |
