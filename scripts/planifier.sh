#!/usr/bin/env bash
# Planifie le rafraîchissement quotidien des cours (lundi→vendredi, 18h15, après la clôture de Paris).
#  - Sous WSL : tâche du Planificateur de tâches Windows « Suivi PEA - cours » qui lance WSL
#    (fonctionne même si aucun terminal WSL n'est ouvert ; rattrapée au démarrage si le PC était éteint).
#  - Sous Linux/macOS : ligne crontab.
# Usage : scripts/planifier.sh [--supprimer]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CMD="'$ROOT/scripts/refresh-quotidien.sh'"
NAME="Suivi PEA - cours"

if [ -n "${WSL_DISTRO_NAME:-}" ] && command -v schtasks.exe >/dev/null; then
  if [ "${1:-}" = "--supprimer" ]; then schtasks.exe /Delete /TN "$NAME" /F; exit; fi
  XML="$(mktemp --suffix=.xml)"
  # Chemin avec espaces : on passe par --cd et un script dédié plutôt que bash -c
  ARGS="-d $WSL_DISTRO_NAME --cd &quot;$ROOT&quot; -e ./scripts/refresh-quotidien.sh"
  cat > "$XML" <<EOF
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Rafraîchit data/market.json (cours et dividendes publics) pour l'application Suivi PEA.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>2026-01-05T18:15:00</StartBoundary><Enabled>true</Enabled>
    <ScheduleByWeek><DaysOfWeek><Monday/><Tuesday/><Wednesday/><Thursday/><Friday/></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>
  </CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><StartWhenAvailable>true</StartWhenAvailable><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>PT15M</ExecutionTimeLimit><Hidden>true</Hidden><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy></Settings>
  <Actions Context="Author"><Exec><Command>C:\Windows\System32\wsl.exe</Command><Arguments>$ARGS</Arguments></Exec></Actions>
</Task>
EOF
  iconv -f UTF-8 -t UTF-16 "$XML" > "$XML.16"
  schtasks.exe /Create /TN "$NAME" /XML "$(wslpath -w "$XML.16")" /F
  rm -f "$XML" "$XML.16"
  echo "Tâche Windows « $NAME » créée (lun→ven 18h15). Tester : schtasks.exe /Run /TN \"$NAME\" ; journal : data/refresh.log"
else
  LINE="15 18 * * 1-5 $CMD # suivi-pea"
  if [ "${1:-}" = "--supprimer" ]; then crontab -l 2>/dev/null | grep -v '# suivi-pea' | crontab -; exit; fi
  (crontab -l 2>/dev/null | grep -v '# suivi-pea'; echo "$LINE") | crontab -
  echo "Crontab ajoutée : $LINE"
fi
