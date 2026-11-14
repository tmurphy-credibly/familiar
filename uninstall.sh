#!/usr/bin/env bash
# Removes Familiar's hooks, opencode plugin and GNOME extension.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="familiar@tmurphy-credibly.github.io"
hook="$root/hooks/familiar-hook.sh"
settings="$HOME/.claude/settings.json"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"

if [ -f "$settings" ]; then
  jq --arg cmd "$hook" '
    if .hooks then
      .hooks |= (with_entries(.value |= map(select(any(.hooks[]?; .command == $cmd) | not)))
                 | with_entries(select(.value | length > 0)))
    else . end
  ' "$settings" >"$settings.tmp"
  mv "$settings.tmp" "$settings"
fi

for d in plugin plugins; do
  link="$config_home/opencode/$d/familiar.js"
  [ -L "$link" ] && [[ "$(readlink "$link")" == */opencode/familiar.js ]] && rm -f "$link"
done

gnome-extensions disable "$uuid" 2>/dev/null || true
current="$(gsettings get org.gnome.shell enabled-extensions)"
updated="$(sed -E "s/, '$uuid'//; s/'$uuid', //; s/'$uuid'//" <<<"$current")"
gsettings set org.gnome.shell enabled-extensions "$updated"

rm -f "$HOME/.local/share/gnome-shell/extensions/$uuid"
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/familiar"
echo "Familiar removed."
