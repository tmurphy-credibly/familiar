#!/usr/bin/env bash
# Installs Familiar: links the GNOME extension, enables it, registers the
# Claude Code hooks in ~/.claude/settings.json (backup kept), and links the
# opencode plugin and Pi extension if those are installed. Idempotent. Also migrates an
# install from when the project was called Claude Pet.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
uuid="familiar@tmurphy-credibly.github.io"
hook="$root/hooks/familiar-hook.sh"
settings="$HOME/.claude/settings.json"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
cache_home="${XDG_CACHE_HOME:-$HOME/.cache}"
events='["SessionStart","UserPromptSubmit","PreToolUse","PostToolUse","PostToolUseFailure","PermissionRequest","Notification","PreCompact","Stop","StopFailure","SessionEnd"]'
# Earlier names: extension IDs, and the hook script Claude Code was pointed at.
legacy_uuids=("claude-pet@tmurphy" "claude-pet@tmurphy-credibly.github.io")
legacy_hook_re='/hooks/claude-pet-hook\.sh$'

for tool in jq gsettings gnome-extensions; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
shell_major="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
supported="$(jq -r '."shell-version" | join(", ")' "$root/extension/$uuid/metadata.json")"
if [[ ",$(jq -r '."shell-version" | join(",")' "$root/extension/$uuid/metadata.json")," != *",$shell_major,"* ]]; then
  echo "Warning: GNOME Shell ${shell_major:-unknown} detected; this extension is tested on GNOME $supported." >&2
  echo "         GNOME will refuse to load it until shell-version in metadata.json includes your version." >&2
fi

chmod +x "$hook"

# 0. Carry over config and custom pets from Claude Pet, and drop its old cache.
if [ -d "$config_home/claude-pet" ] && [ ! -e "$config_home/familiar" ]; then
  mv "$config_home/claude-pet" "$config_home/familiar"
  echo "Moved $config_home/claude-pet to $config_home/familiar."
fi
rm -rf "$cache_home/claude-pet"

# 1. GNOME extension
ext_dir="$HOME/.local/share/gnome-shell/extensions"
mkdir -p "$ext_dir"
ln -sfn "$root/extension/$uuid" "$ext_dir/$uuid"

original="$(gsettings get org.gnome.shell enabled-extensions)"
current="$original"
for legacy in "${legacy_uuids[@]}"; do
  if [ -L "$ext_dir/$legacy" ] || [ -d "$ext_dir/$legacy" ]; then
    gnome-extensions disable "$legacy" 2>/dev/null || true
    rm -rf "${ext_dir:?}/$legacy"
  fi
  current="$(sed -E "s/, '$legacy'//; s/'$legacy', //; s/'$legacy'//" <<<"$current")"
done
if [[ "$current" != *"'$uuid'"* ]]; then
  if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
    current="['$uuid']"
  else
    current="${current%]}, '$uuid']"
  fi
fi
[ "$current" != "$original" ] && gsettings set org.gnome.shell enabled-extensions "$current"

# 2. Claude Code hooks (replacing ours, including any left from Claude Pet)
mkdir -p "$(dirname "$settings")"
[ -f "$settings" ] || echo '{}' >"$settings"
cp "$settings" "$settings.bak-familiar"
jq --arg cmd "$hook" --arg legacy "$legacy_hook_re" --argjson events "$events" '
  def ours: .command == $cmd or ((.command // "") | test($legacy));
  .hooks //= {}
  | .hooks |= with_entries(.value |= map(select(any(.hooks[]?; ours) | not)))
  | reduce $events[] as $e (.;
      .hooks[$e] = ((.hooks[$e] // []) + [{hooks: [{type: "command", command: $cmd, timeout: 5}]}]))
  | .hooks |= with_entries(select(.value | length > 0))
' "$settings" >"$settings.tmp"
mv "$settings.tmp" "$settings"

# 3. opencode plugin (1.18.29+ and 2.x share one file; each reads a different folder)
oc_config="$config_home/opencode"
for d in plugin plugins; do   # links left from Claude Pet
  old="$oc_config/$d/claude-pet.js"
  [ -L "$old" ] && [[ "$(readlink "$old")" == */opencode/claude-pet.js ]] && rm -f "$old"
done
opencode_bin="$(command -v opencode || true)"
[ -z "$opencode_bin" ] && [ -x "$HOME/.opencode/bin/opencode" ] && opencode_bin="$HOME/.opencode/bin/opencode"
opencode_msg=""
if [ -n "$opencode_bin" ]; then
  oc_version="$("$opencode_bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  if [ "${oc_version%%.*}" = "1" ]; then oc_dir="$oc_config/plugin"; else oc_dir="$oc_config/plugins"; fi
  mkdir -p "$oc_dir"
  ln -sfn "$root/opencode/familiar.js" "$oc_dir/familiar.js"
  opencode_msg="opencode ${oc_version:-(unknown version)}: plugin linked into $oc_dir."
  if [ "${oc_version%%.*}" = "1" ]; then
    opencode_msg="$opencode_msg Live for new opencode sessions."
  else
    opencode_msg="$opencode_msg Run 'opencode service restart' to load it."
  fi
fi

# 4. Pi extension (Pi 1.x and 0.7x)
pi_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
pi_msg=""
if command -v pi >/dev/null || [ -d "$pi_dir" ]; then
  mkdir -p "$pi_dir/extensions"
  ln -sfn "$root/pi/familiar.js" "$pi_dir/extensions/familiar.js"
  pi_msg="Pi: extension linked into $pi_dir/extensions. Live for new Pi sessions (or /reload)."
fi

echo "Installed. Hooks are live for new Claude Code sessions."
[ -n "$opencode_msg" ] && echo "$opencode_msg"
[ -n "$pi_msg" ] && echo "$pi_msg"
echo "Log out and back in once so GNOME Shell loads the extension."
echo "Settings backup: $settings.bak-familiar"
