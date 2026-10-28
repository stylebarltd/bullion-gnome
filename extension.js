// SPDX-License-Identifier: GPL-3.0-or-later
import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const COINGECKO = 'https://api.coingecko.com/api/v3';
const GOLD_API = 'https://api.gold-api.com/price';
const FRANKFURTER = 'https://api.frankfurter.dev/v1/latest';

const HISTORY_SAMPLE_MS = 10 * 60 * 1000;
const HISTORY_KEEP_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_BACKOFF_S = 600;
const SPARK_POINTS = 48;

const BUNDLED_ICONS = new Set(['XAU', 'XAG', 'BTC', 'ETH', 'SOL', 'XRP']);

const COLOR_UP = [0.34, 0.89, 0.53];
const COLOR_DOWN = [1.0, 0.48, 0.39];
const COLOR_FLAT = [0.6, 0.6, 0.58];

function fmtPrice(p, currency) {
    if (p == null || !Number.isFinite(p)) return '…';
    const d = p >= 100 ? 0 : p >= 10 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 4 : 8;
    try {
        return p.toLocaleString('en-US', {
            style: 'currency', currency: currency.toUpperCase(),
            minimumFractionDigits: d, maximumFractionDigits: d,
        });
    } catch (_e) {
        return p.toFixed(d);
    }
}

function fmtChange(chg) {
    if (chg == null) return '';
    return `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%`;
}

function trendClass(chg) {
    if (chg == null) return 'bullion-flat';
    return chg >= 0 ? 'bullion-up' : 'bullion-down';
}

function hashColor(sym) {
    let h = 0;
    for (const ch of sym) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const s = 0.55, l = 0.42;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
        : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [r, g, b].map(v => Math.round((v + m) * 255));
}

function parseCoin(entry) {
    const [id, sym, ...rest] = entry.split(':');
    return {key: id, id, sym: (sym || id).toUpperCase(), name: rest.join(':') || sym || id, kind: 'crypto'};
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(ext, settings) {
        super._init(0.0, 'Bullion');
        this.add_style_class_name('bullion-button');
        this._ext = ext;
        this._settings = settings;
        this._cancellable = new Gio.Cancellable();
        this._session = new Soup.Session({timeout: 15, user_agent: 'gnome-shell-bullion/1.0 (+https://github.com/stylebarltd/bullion-gnome)'});

        this._crypto = {};
        this._metalsUsd = {};
        this._fx = 1;
        this._fxCurrency = 'usd';
        this._history = this._loadHistory();
        this._idx = 0;
        this._failures = 0;
        this._stale = false;
        this._updated = null;
        this._rows = {};

        this._iconBin = new St.Bin({y_align: Clutter.ActorAlign.CENTER, style: 'margin-right: 6px;'});
        this._label = new St.Label({text: 'Loading…', style_class: 'bullion-panel', x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._arrow = new St.Label({text: '', style_class: 'bullion-panel', y_align: Clutter.ActorAlign.CENTER, style: 'margin-left: 5px;'});
        // Fixed-width slots (see _fitPanel) so rotating between assets doesn't shift the top bar.
        this._labelBin = new St.Bin({child: this._label});
        this._arrowBin = new St.Bin({child: this._arrow});
        const box = new St.BoxLayout({style_class: 'bullion-chip'});
        for (const w of [this._iconBin, this._labelBin, this._arrowBin]) box.add_child(w);
        this.add_child(box);

        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._ratioItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        this._ratioLabel = new St.Label({text: '', style_class: 'bullion-meta', x_expand: true});
        this._ratioItem.add_child(this._ratioLabel);
        this.menu.addMenuItem(this._ratioItem);

        this._updatedItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        this._updatedLabel = new St.Label({text: '', style_class: 'bullion-meta', x_expand: true});
        this._updatedItem.add_child(this._updatedLabel);
        this.menu.addMenuItem(this._updatedItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._refresh());
        this.menu.addMenuItem(refresh);
        const prefs = new PopupMenu.PopupMenuItem('Settings');
        prefs.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(prefs);

        this._settingsId = this._settings.connect('changed', (_s, key) => this._onSettingsChanged(key));

        this._rebuild();
        this._refresh();
        this._startRotation();
    }

    // ---- assets & settings -------------------------------------------------

    get _currency() {
        return this._settings.get_string('currency');
    }

    _assets() {
        const out = [];
        if (this._settings.get_boolean('show-gold'))
            out.push({key: 'XAU', sym: 'XAU', name: 'Gold', kind: 'metal'});
        if (this._settings.get_boolean('show-silver'))
            out.push({key: 'XAG', sym: 'XAG', name: 'Silver', kind: 'metal'});
        for (const c of this._settings.get_strv('coins')) out.push(parseCoin(c));
        return out;
    }

    // Assets that rotate in the panel: the 'panel-assets' subset of the tracked ones, or all when empty.
    _rotation() {
        const keys = new Set(this._settings.get_strv('panel-assets'));
        const chosen = this._tracked.filter(a => keys.has(a.key));
        return chosen.length ? chosen : this._tracked;
    }

    _onSettingsChanged(key) {
        if (key === 'rotate-seconds') {
            this._startRotation();
            return;
        }
        if (key === 'currency') {
            this._crypto = {};
            this._fx = 1;
            this._fxCurrency = 'usd';
        }
        // Debounce bursts (e.g. reordering coins in prefs).
        if (this._settingsDebounce) GLib.source_remove(this._settingsDebounce);
        this._settingsDebounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._settingsDebounce = 0;
            this._rebuild();
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- UI ----------------------------------------------------------------

    _badge(asset, size) {
        if (BUNDLED_ICONS.has(asset.sym)) {
            const file = Gio.File.new_for_path(`${this._ext.path}/icons/${asset.sym}.svg`);
            return new St.Icon({gicon: new Gio.FileIcon({file}), icon_size: size, y_align: Clutter.ActorAlign.CENTER});
        }
        const [r, g, b] = hashColor(asset.sym);
        const label = new St.Label({
            text: asset.sym.slice(0, 3),
            style: `color: #fff; font-weight: bold; font-size: ${Math.round(size * 0.4)}px;`,
        });
        return new St.Bin({
            child: label,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: rgb(${r},${g},${b}); border-radius: ${size}px; width: ${size}px; height: ${size}px;`,
        });
    }

    _makeSparkline() {
        const area = new St.DrawingArea({width: 64, height: 18, y_align: Clutter.ActorAlign.CENTER, style: 'margin: 0 8px;'});
        area.sparkData = null;
        area.sparkColor = COLOR_FLAT;
        area.connect('repaint', () => {
            const pts = area.sparkData;
            if (!pts || pts.length < 2) return;
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const min = Math.min(...pts), max = Math.max(...pts);
            const span = max - min || 1;
            const pad = 2;
            const [r, g, b] = area.sparkColor;
            cr.setLineWidth(1.5);
            cr.setLineJoin(1); // round
            cr.setSourceRGBA(r, g, b, 1);
            pts.forEach((v, i) => {
                const x = pad + i * (w - 2 * pad) / (pts.length - 1);
                const y = h - pad - (v - min) / span * (h - 2 * pad);
                if (i === 0) cr.moveTo(x, y); else cr.lineTo(x, y);
            });
            cr.stroke();
            cr.$dispose();
        });
        return area;
    }

    _rebuild() {
        this._section.removeAll();
        this._rows = {};
        this._tracked = this._assets();
        this._panelAssets = this._rotation();
        for (const a of this._tracked) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const badge = this._badge(a, 20);
            const name = new St.Label({text: a.name, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const spark = this._makeSparkline();
            const val = new St.Label({text: '…', style_class: 'bullion-val', y_align: Clutter.ActorAlign.CENTER});
            const chg = new St.Label({text: '', style_class: 'bullion-chg', y_align: Clutter.ActorAlign.CENTER});
            for (const w of [badge, name, spark, val, chg]) item.add_child(w);
            this._section.addMenuItem(item);
            this._rows[a.key] = {item, val, chg, spark, name};
        }
        this._idx = Math.min(this._idx, Math.max(0, this._panelAssets.length - 1));
        this._shownKey = null;
        this._render();
    }

    _startRotation() {
        if (this._rotateId) GLib.source_remove(this._rotateId);
        const secs = this._settings.get_int('rotate-seconds');
        this._rotateId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            if (this._panelAssets.length > 1) {
                this._idx = (this._idx + 1) % this._panelAssets.length;
                this._renderPanel();
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // ---- data --------------------------------------------------------------

    async _getJson(url) {
        const msg = Soup.Message.new('GET', url);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (msg.status_code !== 200) throw new Error(`HTTP ${msg.status_code} for ${url}`);
        return JSON.parse(new TextDecoder().decode(bytes.get_data()));
    }

    async _refresh() {
        if (this._busy) {
            this._pending = true;
            return;
        }
        this._busy = true;
        if (this._nextRefreshId) {
            GLib.source_remove(this._nextRefreshId);
            this._nextRefreshId = 0;
        }
        const currency = this._currency;
        const coins = this._tracked.filter(a => a.kind === 'crypto');
        const metals = this._tracked.filter(a => a.kind === 'metal');
        const needRatio = this._settings.get_boolean('show-ratio');
        const metalSyms = new Set(metals.map(m => m.sym));
        if (needRatio) { metalSyms.add('XAU'); metalSyms.add('XAG'); }

        const jobs = [];
        if (coins.length) {
            const ids = coins.map(c => encodeURIComponent(c.id)).join(',');
            jobs.push(this._getJson(`${COINGECKO}/coins/markets?vs_currency=${currency}&ids=${ids}&sparkline=true&price_change_percentage=24h`)
                .then(arr => {
                    const next = {};
                    for (const x of arr) {
                        next[x.id] = {
                            price: x.current_price,
                            chg: x.price_change_percentage_24h_in_currency ?? x.price_change_percentage_24h ?? null,
                            spark: (x.sparkline_in_7d?.price ?? []).slice(-24),
                        };
                    }
                    this._crypto = next;
                }));
        }
        if (metalSyms.size) {
            for (const sym of metalSyms) {
                jobs.push(this._getJson(`${GOLD_API}/${sym}`).then(j => {
                    this._metalsUsd[sym] = j.price;
                    this._recordHistory(sym, j.price);
                }));
            }
            if (currency !== 'usd') {
                jobs.push(this._getJson(`${FRANKFURTER}?base=USD&symbols=${currency.toUpperCase()}`).then(j => {
                    this._fx = j.rates[currency.toUpperCase()];
                    this._fxCurrency = currency;
                }));
            }
        }

        const res = await Promise.allSettled(jobs);
        this._busy = false;
        if (this._cancellable.is_cancelled()) return;
        if (this._pending) {
            this._pending = false;
            this._refresh();
            return;
        }

        const failed = res.filter(r => r.status === 'rejected');
        for (const r of failed) console.error(`bullion: ${r.reason}`);
        if (jobs.length && failed.length === jobs.length) {
            this._failures++;
            this._stale = true;
        } else {
            this._failures = 0;
            this._stale = false;
            this._updated = GLib.DateTime.new_now_local();
        }
        this._saveHistory();
        this._render();

        const base = this._settings.get_int('refresh-seconds');
        const delay = Math.min(MAX_BACKOFF_S, base * 2 ** Math.min(this._failures, 4));
        this._nextRefreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(delay, 30), () => {
            this._nextRefreshId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---- metals history (24h change is computed locally) -------------------

    get _historyFile() {
        return GLib.build_filenamev([GLib.get_user_cache_dir(), 'bullion', 'history.json']);
    }

    _loadHistory() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._historyFile);
            if (ok) return JSON.parse(new TextDecoder().decode(bytes));
        } catch (_e) { /* first run */ }
        return {};
    }

    _saveHistory() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._historyFile), 0o755);
            GLib.file_set_contents(this._historyFile, JSON.stringify(this._history));
        } catch (e) {
            console.error(`bullion: could not save history: ${e.message}`);
        }
    }

    _recordHistory(sym, usd) {
        const now = Date.now();
        const h = this._history[sym] ??= [];
        const last = h[h.length - 1];
        if (!last || now - last[0] >= HISTORY_SAMPLE_MS) h.push([now, usd]);
        while (h.length && now - h[0][0] > HISTORY_KEEP_MS) h.shift();
    }

    _metalChange(sym) {
        const h = this._history[sym];
        const price = this._metalsUsd[sym];
        if (!h || !h.length || price == null) return null;
        const now = Date.now();
        // Latest sample at least 24h old; otherwise the oldest if it's close to a day.
        let base = null;
        for (const s of h) if (now - s[0] >= DAY_MS) base = s;
        if (!base && now - h[0][0] >= 20 * 3600 * 1000) base = h[0];
        if (!base || now - base[0] > 36 * 3600 * 1000) return null;
        return (price - base[1]) / base[1] * 100;
    }

    _metalSpark(sym) {
        const h = (this._history[sym] ?? []).filter(s => Date.now() - s[0] <= DAY_MS).map(s => s[1]);
        if (h.length < 3) return null;
        const step = Math.max(1, Math.ceil(h.length / SPARK_POINTS));
        return h.filter((_v, i) => i % step === 0 || i === h.length - 1);
    }

    // ---- rendering ---------------------------------------------------------

    _dataFor(a) {
        if (a.kind === 'crypto') {
            const d = this._crypto[a.id];
            return d ?? null;
        }
        const usd = this._metalsUsd[a.sym];
        if (usd == null || this._fxCurrency !== this._currency) return null;
        const spark = this._metalSpark(a.sym);
        return {
            price: usd * this._fx,
            chg: this._metalChange(a.sym),
            spark: spark ? spark.map(v => v * this._fx) : null,
        };
    }

    _render() {
        const cur = this._currency;
        for (const a of this._tracked) {
            const r = this._rows[a.key];
            const d = this._dataFor(a);
            if (!r || !d) continue;
            r.val.text = fmtPrice(d.price, cur);
            r.chg.text = fmtChange(d.chg);
            r.chg.style_class = `bullion-chg ${trendClass(d.chg)}`;
            r.spark.sparkData = d.spark;
            r.spark.sparkColor = d.chg == null ? COLOR_FLAT : d.chg >= 0 ? COLOR_UP : COLOR_DOWN;
            r.spark.queue_repaint();
        }

        const xau = this._metalsUsd.XAU, xag = this._metalsUsd.XAG;
        const showRatio = this._settings.get_boolean('show-ratio') && xau && xag;
        this._ratioItem.visible = !!showRatio;
        if (showRatio) this._ratioLabel.text = `Gold/Silver ratio  ${(xau / xag).toFixed(1)}`;

        this._updatedLabel.text = this._updated
            ? `Updated ${this._updated.format('%H:%M')}${this._stale ? ' (offline — showing old data)' : ''}`
            : (this._stale ? 'Offline — could not fetch prices' : 'Fetching…');
        this._fitPanel();
        this._renderPanel();
    }

    _panelText(a) {
        const d = this._dataFor(a);
        const price = d ? fmtPrice(d.price, this._currency) : '…';
        // metals have no 24h change; fill the arrow slot with the unit instead
        if (!d || d.chg == null) return {price, arrow: d && a.kind === 'metal' ? '/oz' : '', chg: null};
        const arrow = d.chg >= 0 ? '▲' : '▼';
        const showChg = this._settings.get_boolean('panel-show-change');
        return {price, arrow: showChg ? `${arrow} ${Math.abs(d.chg).toFixed(1)}%` : arrow, chg: d.chg};
    }

    // Size both slots to the widest text of any asset in the rotation.
    _fitPanel() {
        if (!this._label.get_stage()) return;   // not styled yet; the next refresh fits it
        let price = 0, arrow = 0;
        for (const a of this._panelAssets) {
            const t = this._panelText(a);
            this._label.text = t.price;
            this._arrow.text = t.arrow;
            price = Math.max(price, this._label.get_preferred_width(-1)[1]);
            arrow = Math.max(arrow, this._arrow.get_preferred_width(-1)[1]);
        }
        // Set natural width too: a min above the natural width makes Clutter abort the shell.
        for (const [bin, w] of [[this._labelBin, price], [this._arrowBin, arrow]]) {
            bin.min_width = w;
            bin.natural_width = w;
        }
    }

    _renderPanel() {
        const a = this._panelAssets[this._idx];
        if (!a) {
            this._label.text = 'Bullion';
            this._arrow.text = '';
            this._iconBin.set_child(null);
            return;
        }
        if (this._shownKey !== a.key) {
            this._iconBin.set_child(this._badge(a, 16));
            this._shownKey = a.key;
        }
        const t = this._panelText(a);
        this._label.text = t.price;
        this._arrow.text = t.arrow;
        this._arrow.style_class = `bullion-panel ${trendClass(t.chg)}`;
        if (this._stale) this.add_style_class_name('bullion-stale');
        else this.remove_style_class_name('bullion-stale');
    }

    destroy() {
        this._cancellable.cancel();
        for (const id of [this._rotateId, this._nextRefreshId, this._settingsDebounce])
            if (id) GLib.source_remove(id);
        this._rotateId = this._nextRefreshId = this._settingsDebounce = 0;
        if (this._settingsId) this._settings.disconnect(this._settingsId);
        this._session.abort();
        super.destroy();
    }
});

export default class BullionExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new Indicator(this, this._settings);
        Main.panel.addToStatusArea(this.uuid, this._indicator, -1, 'left'); // left side of the top bar, after Activities
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
