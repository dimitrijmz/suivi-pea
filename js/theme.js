// Applique le thème choisi avant l'affichage (évite un flash clair/sombre).
try {
  var t = localStorage.getItem("pea.theme");
  if (t) document.documentElement.dataset.theme = t;
} catch (e) { /* stockage indisponible : thème du système */ }
