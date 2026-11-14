#!/usr/bin/env bash
# Runs install.sh / uninstall.sh against a throwaway $HOME with stubbed GNOME and
# opencode commands, including migrating an install from the Claude Pet days.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT
export HOME="$sandbox/home" XDG_CONFIG_HOME="$sandbox/home/.config" XDG_CACHE_HOME="$sandbox/home/.cache"
bin="$sandbox/bin"
mkdir -p "$bin" "$HOME/.claude"
fail=0
check() { if eval "$1"; then echo "ok   $2"; else echo "FAIL $2"; fail=1; fi; }

# Stubs: gsettings keeps enabled-extensions in a file; opencode reports a version.
cat >"$bin/gsettings" <<EOF
#!/usr/bin/env bash
f="$sandbox/enabled"
[ -f "\$f" ] || echo "@as []" >"\$f"
case "\$1" in get) cat "\$f" ;; set) echo "\$4" >"\$f" ;; esac
EOF
printf '#!/usr/bin/env bash\nexit 0\n' >"$bin/gnome-extensions"
printf '#!/usr/bin/env bash\necho "opencode v${OPENCODE_STUB_VERSION:-2.1.4}"\n' >"$bin/opencode"
printf '#!/usr/bin/env bash\necho "GNOME Shell 50.0"\n' >"$bin/gnome-shell"
printf '#!/usr/bin/env bash\necho 1.5.2\n' >"$bin/pi"
chmod +x "$bin"/*
export PATH="$bin:$PATH"

# An install left over from Claude Pet, plus a hook of the user's own.
old_uuid="claude-pet@tmurphy-credibly.github.io"
mkdir -p "$HOME/.local/share/gnome-shell/extensions/$old_uuid" "$XDG_CONFIG_HOME/claude-pet/pets" \
  "$XDG_CACHE_HOME/claude-pet/sessions" "$XDG_CONFIG_HOME/opencode/plugins"
echo '{"pet":"fox"}' >"$XDG_CONFIG_HOME/claude-pet/config.json"
ln -s /old/clone/opencode/claude-pet.js "$XDG_CONFIG_HOME/opencode/plugins/claude-pet.js"
echo "['other@ext', '$old_uuid']" >"$sandbox/enabled"
cat >"$HOME/.claude/settings.json" <<'EOF'
{"model": "opus", "hooks": {
  "Stop": [{"hooks": [{"type": "command", "command": "/old/clone/hooks/claude-pet-hook.sh"}]},
           {"hooks": [{"type": "command", "command": "notify-send done"}]}],
  "PreToolUse": [{"hooks": [{"type": "command", "command": "/old/clone/hooks/claude-pet-hook.sh"}]}]
}}
EOF

out="$(bash "$root/install.sh" 2>&1)" || { echo "FAIL install.sh exited: $out"; exit 1; }
s="$HOME/.claude/settings.json"
uuid="familiar@tmurphy-credibly.github.io"
hook="$root/hooks/familiar-hook.sh"
check '[ "$(readlink "$HOME/.local/share/gnome-shell/extensions/$uuid")" = "$root/extension/$uuid" ]' "extension linked"
check '[ ! -e "$HOME/.local/share/gnome-shell/extensions/$old_uuid" ]' "old extension removed"
check '[ "$(cat "$sandbox/enabled")" = "['"'"'other@ext'"'"', '"'"'$uuid'"'"']" ]' "enabled list swaps old for new, keeps others"
check '[ "$(jq -r .pet "$XDG_CONFIG_HOME/familiar/config.json")" = fox ] && [ ! -e "$XDG_CONFIG_HOME/claude-pet" ]' "config moved to ~/.config/familiar"
check '[ ! -e "$XDG_CACHE_HOME/claude-pet" ]' "old cache removed"
check '! grep -q claude-pet-hook "$s"' "old hook commands removed"
check '[ "$(jq "[.hooks[][] | select(.hooks[0].command == \"$hook\")] | length" "$s")" = 11 ]' "new hook on all 11 events"
check '[ "$(jq -r ".hooks.Stop[] | .hooks[0].command" "$s" | grep -c notify-send)" = 1 ] && [ "$(jq -r .model "$s")" = opus ]' "user's own hooks and settings kept"
check '[ ! -L "$XDG_CONFIG_HOME/opencode/plugins/claude-pet.js" ]' "old opencode link removed"
check '[ "$(readlink "$XDG_CONFIG_HOME/opencode/plugins/familiar.js")" = "$root/opencode/familiar.js" ]' "opencode 2.x plugin linked into plugins/"
check '[ "$(readlink "$HOME/.pi/agent/extensions/familiar.js")" = "$root/pi/familiar.js" ]' "Pi extension linked into ~/.pi/agent/extensions/"

bash "$root/install.sh" >/dev/null 2>&1
check '[ "$(jq "[.hooks[][] | select(.hooks[0].command == \"$hook\")] | length" "$s")" = 11 ]' "second install doesn't duplicate hooks"

OPENCODE_STUB_VERSION=1.19.5 bash "$root/install.sh" >/dev/null 2>&1
check '[ -L "$XDG_CONFIG_HOME/opencode/plugin/familiar.js" ]' "opencode 1.x plugin linked into plugin/"

bash "$root/uninstall.sh" >/dev/null 2>&1
check '! grep -q familiar-hook "$s" && grep -q notify-send "$s"' "uninstall removes only our hooks"
check '[ ! -e "$XDG_CONFIG_HOME/opencode/plugins/familiar.js" ] && [ ! -e "$XDG_CONFIG_HOME/opencode/plugin/familiar.js" ]' "uninstall removes opencode links"
check '[ ! -e "$HOME/.pi/agent/extensions/familiar.js" ]' "uninstall removes the Pi link"
check '[ "$(cat "$sandbox/enabled")" = "['"'"'other@ext'"'"']" ]' "uninstall disables the extension"
check '[ -f "$XDG_CONFIG_HOME/familiar/config.json" ]' "uninstall keeps your config"

exit $fail
