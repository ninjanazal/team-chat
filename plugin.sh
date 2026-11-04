#!/usr/bin/env bash
# Install, update or remove the team-chat plugin for Claude Code.
# Run it and answer the questions: ./plugin.sh
set -uo pipefail

PLUGIN=team-chat
MARKETPLACE=team-chat # the "name" in .claude-plugin/marketplace.json
GITHUB=ninjanazal/team-chat
ID="$PLUGIN@$MARKETPLACE"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── styling ────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m' D=$'\033[2m' R=$'\033[0m'
  RED=$'\033[31m' GRN=$'\033[32m' YEL=$'\033[33m' CYN=$'\033[36m' MAG=$'\033[35m'
else
  B= D= R= RED= GRN= YEL= CYN= MAG=
fi

ok()   { printf '  %s✔%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$R" "$*"; }
fail() { printf '  %s✘%s %s\n' "$RED" "$R" "$*" >&2; }
info() { printf '  %s%s%s\n' "$D" "$*" "$R"; }
die()  { fail "$*"; exit 1; }

header() {
  local version
  version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/.claude-plugin/plugin.json" 2>/dev/null | head -1)"
  echo
  printf '  %s╭──────────────────────────────────────────╮%s\n' "$MAG" "$R"
  printf '  %s│%s  %s💬 team-chat%s %-27s%s│%s\n' "$MAG" "$R" "$B" "$R" "${version:+v$version}" "$MAG" "$R"
  printf '  %s│%s  %sClaude Code plugin manager%s              %s│%s\n' "$MAG" "$R" "$D" "$R" "$MAG" "$R"
  printf '  %s╰──────────────────────────────────────────╯%s\n' "$MAG" "$R"
}

# ask "Question" "option 1" "option 2" … → sets $choice to the number picked.
# Single keypress when there are ≤ 9 options; Enter picks option 1.
ask() {
  local question="$1"; shift
  echo
  printf '  %s?%s %s%s%s\n' "$CYN" "$R" "$B" "$question" "$R"
  local i=1
  for option in "$@"; do
    printf '    %s%d%s  %s\n' "$CYN" "$i" "$R" "$option"
    i=$((i + 1))
  done
  while true; do
    printf '  %s›%s ' "$CYN" "$R"
    read -rsn1 choice || exit 1
    [ -z "$choice" ] && choice=1
    if [[ "$choice" =~ ^[0-9]$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le $# ]; then
      printf '%s%s%s\n' "$B" "${!choice}" "$R"
      return
    fi
    [[ "$choice" =~ ^[qQ]$ ]] && { echo; info "Nothing done."; exit 0; }
    printf '%sPick 1–%d%s\r\033[K' "$D" "$#" "$R"
  done
}

# confirm "Question" → returns 0 for yes (default), 1 for no
confirm() {
  local reply
  printf '\n  %s?%s %s %s[Y/n]%s ' "$CYN" "$R" "$1" "$D" "$R"
  read -rsn1 reply || exit 1
  if [[ "$reply" =~ ^[nN]$ ]]; then echo "no"; return 1; fi
  echo "yes"
}

# run cmd… → shows the command, runs it, indents its output, reports result
run() {
  printf '\n  %s$ %s%s\n' "$D" "$*" "$R"
  local out status
  out="$("$@" 2>&1)"; status=$?
  [ -n "$out" ] && printf '%s\n' "$out" | sed "s/^/    ${D}│${R} /"
  return $status
}

# ── checks ─────────────────────────────────────────────────────────────────
header
command -v claude >/dev/null || die "The claude CLI is not on PATH. Install Claude Code first."

installed="$(claude plugin list 2>/dev/null | grep -A3 "$ID" | sed -n 's/.*Scope: *//p' | paste -sd, - || true)"
echo
if [ -n "$installed" ]; then
  ok "Installed ${D}(scope: $installed)${R}"
else
  info "○ Not installed yet"
fi

# ── questions ──────────────────────────────────────────────────────────────
ask "What do you want to do?" "Install" "Update" "Remove" "Quit"
case "$choice" in 1) action=install ;; 2) action=update ;; 3) action=remove ;; *) echo; info "Nothing done."; exit 0 ;; esac

source=
if [ "$action" = install ]; then
  if [ -f "$HERE/.claude-plugin/marketplace.json" ]; then
    ask "Install from?" \
      "GitHub      ${D}$GITHUB${R}" \
      "This folder ${D}$HERE (for development)${R}"
    if [ "$choice" = 1 ]; then source="$GITHUB"; else source="$HERE"; fi
  else
    source="$GITHUB"
  fi
fi

ask "Where?" \
  "System  ${D}every project on this machine${R}" \
  "Local   ${D}one project only, just for you${R}"
if [ "$choice" = 1 ]; then
  scope=user
  where="all projects"
else
  scope=local
  echo
  printf '  %s?%s %sProject folder%s %s(%s)%s ' "$CYN" "$R" "$B" "$R" "$D" "$PWD" "$R"
  read -r project || exit 1
  project="${project:-$PWD}"
  project="${project/#\~/$HOME}"
  [ -d "$project" ] || die "No folder $project."
  cd "$project" || exit 1
  where="$PWD"
fi

# ── summary ────────────────────────────────────────────────────────────────
echo
printf '  %sSummary%s\n' "$B" "$R"
printf '    %-8s %s\n' "Action" "$action"
[ -n "$source" ] && printf '    %-8s %s\n' "Source" "$source"
printf '    %-8s %s %s(%s)%s\n' "Scope" "$where" "$D" "$scope" "$R"
confirm "Go ahead?" || { info "Nothing done."; exit 0; }

# ── do it ──────────────────────────────────────────────────────────────────
case "$action" in
  install)
    if run claude plugin install "$PLUGIN" --marketplace "$source" --scope "$scope"; then
      echo; ok "Installed. Restart Claude Code (or start a new session), then run ${B}/team-chat:start${R}."
    else
      echo; fail "Install failed."
      if [ "$source" = "$GITHUB" ]; then
        warn "The GitHub repo must contain .claude-plugin/marketplace.json on its default branch."
        warn "Push your plugin files, or rerun and pick ${B}This folder${R} to install from your local checkout."
      fi
      exit 1
    fi
    ;;
  update)
    run claude plugin marketplace update "$MARKETPLACE" || { echo; fail "Could not refresh the marketplace."; exit 1; }
    if run claude plugin update "$ID" --scope "$scope"; then
      echo; ok "Updated. Restart Claude Code to load the new version."
    else
      echo; fail "Update failed."; exit 1
    fi
    ;;
  remove)
    if run claude plugin uninstall "$ID" --scope "$scope"; then
      echo; ok "Removed. Your teams and team files in .claude/teams/ are left in place."
    else
      echo; fail "Remove failed."; exit 1
    fi
    ;;
esac
echo
