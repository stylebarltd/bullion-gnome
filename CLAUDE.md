# Bullion (GNOME Shell extension)

<!-- Public repo with releases: keep this file free of credentials and local paths. -->

## What this is
Gold, silver and crypto prices in the GNOME top bar: rotating assets with 24h change
arrows, sparklines, gold/silver ratio, a coin picker and 23 display currencies.
Repo `stylebarltd/bullion-gnome` (public, GPL-3.0).

## Stack & layout
- GNOME Shell extension (GJS), uuid `bullion@stylebarltd.github.io`, shell 46–50,
  GSettings schema `org.gnome.shell.extensions.bullion`.
- `extension.js` (panel, menu, fetching) · `prefs.js` (preferences window) ·
  `currencies.js` · `schemas/` · `icons/` · `stylesheet.css`
- `CHANGELOG.md` · `.github/workflows/release.yml` (release zip) · `dist/` (built zip)
- Data: CoinGecko public API (crypto), gold-api.com (metals, USD), Frankfurter (ECB rates).
  No API keys. Metals 24h change is computed locally from samples in
  `~/.cache/bullion/history.json`.

## Commands
```bash
make dev        # compile schemas + symlink the checkout into ~/.local/share/gnome-shell/extensions
make pack       # build dist/bullion@stylebarltd.github.io.shell-extension.zip
make install    # pack + install the zip (a copy, not a symlink)
make uninstall | make clean
gnome-extensions prefs bullion@stylebarltd.github.io
journalctl -f -o cat /usr/bin/gnome-shell
```
Reload after a change: X11 `Alt+F2`, `r`; Wayland: log out and back in.

## Gotchas
- If the extension was installed with `make install`, edits in the checkout do nothing
  until you reinstall. Use `make dev` while developing.
- CoinGecko's free tier is rate limited: keep the refresh interval at 60 s or more.
- Offline: data backs off and dims as stale. Keep that behaviour.
- Keep `CHANGELOG.md` and `version-name` in `metadata.json` in step for releases.
