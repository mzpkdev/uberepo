# überepo demo tape — https://github.com/charmbracelet/vhs
#
# Render from the repo root (after `npm install`):
#
#   vhs .github/assets/demo.tape
#
# Self-contained and offline: the hidden setup builds three local bare repos
# in a temp dir and points git's url.<base>.insteadOf at them, so the demo
# can `uberepo add` real-looking https://github.com/acme/*.git URLs without
# touching the network. GIT_CONFIG_GLOBAL is sandboxed into the temp dir, so
# your actual git config is never read or written. The hidden epilogue
# removes the temp dir again.

Output .github/assets/demo.gif

Require git
Require node

Set Shell "bash"
Set Theme "Catppuccin Mocha"
Set FontSize 22
Set Width 1300
Set Height 680
Set Padding 24
Set TypingSpeed 40ms

# ── hidden setup: local "remotes", workspace, clone ──────────────────────
Hide
Type@1ms `UBEREPO_SRC="$PWD"; uberepo() { node "$UBEREPO_SRC/bin/uberepo.mjs" "$@"; }`
Enter
Type@1ms `DEMO="$(mktemp -d)" && export GIT_CONFIG_GLOBAL="$DEMO/gitconfig" && cd "$DEMO"`
Enter
Type@1ms `git config --global user.name demo && git config --global user.email demo@example.com && git config --global init.defaultBranch main`
Enter
Type@1ms `git config --global url."file://$DEMO/remotes/".insteadOf "https://github.com/acme/"`
Enter
Type@1ms `for r in api web types; do git init -q "seed/$r" && echo "# $r" > "seed/$r/README.md" && git -C "seed/$r" add -A && git -C "seed/$r" commit -qm "initial commit" && git clone -q --bare "seed/$r" "remotes/$r.git"; done`
Enter
Sleep 2s
Type@1ms `uberepo init shop && cd shop`
Enter
Sleep 3s
Type@1ms `uberepo add https://github.com/acme/api.git https://github.com/acme/web.git https://github.com/acme/types.git`
Enter
Sleep 3s
Type@1ms `uberepo clone`
Enter
Sleep 5s
Type@1ms `clear`
Enter
Sleep 1s
Show

# ── the demo: one task = one branch in every repo ─────────────────────────
Sleep 500ms
Type `uberepo open big-rename --goal "Acme → Akko. Every string, every logo, every invoice."`
Sleep 500ms
Enter
Sleep 3.5s

Type "uberepo status"
Sleep 500ms
Enter
Sleep 3s

Type "ls tasks/big-rename/"
Sleep 500ms
Enter
Sleep 3.5s

# ── hidden cleanup: drop the temp dir ─────────────────────────────────────
Hide
Type@1ms `cd / && rm -rf "$DEMO"`
Enter
Sleep 1s
