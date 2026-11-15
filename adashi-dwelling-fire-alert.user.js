// ==UserScript==
// @name         Adashi Dwelling Fire Text Alert
// @namespace    adashi-dwelling-fire-alert
// @version      1.2.0
// @description  Texts your phone the first time a fire call (69E* / 69D* / DW* / BOX*) appears in Adashi.
// @author       you
// @match        https://live.adashi.com/bcfd/apps/AdashiNotify/app/incidents*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @connect      api.twilio.com
// @connect      ntfy.sh
// @connect      textbelt.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   *  SETTINGS — edit this block
   * ========================================================================= */
  const CONFIG = {
    // Which service sends the alert: 'twilio' (real SMS), 'ntfy' (free push
    // notification via the ntfy app), or 'textbelt' (SMS, simple paid key).
    PROVIDER: 'ntfy',

    // --- Twilio (https://www.twilio.com) ---
    TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_AUTH_TOKEN: 'your_auth_token',
    TWILIO_FROM: '+15555550100', // your Twilio phone number
    TO_NUMBERS: ['+15555550123'], // your cell (add more to text several people)

    // --- ntfy (https://ntfy.sh) — install the ntfy app & subscribe to this topic.
    // Pick a long, hard-to-guess topic name; anyone who knows it can read it.
    NTFY_TOPIC: 'truck5_calls_access',

    // --- Textbelt (https://textbelt.com) — uses TO_NUMBERS above ---
    TEXTBELT_KEY: 'textbelt', // 'textbelt' = 1 free text/day for testing

    // Call-type patterns. A call alerts if ANY of these match its row text.
    //   69E… / 69D… : MPDS Protocol 69 Echo/Delta (e.g. 69E01, 69-D-6).
    //                 Addresses like "69 E Main St" or "69 D St" are NOT matched.
    //   DW…   : e.g. DW, DWF, DWELL, DWELLING (uppercase only)
    //   BOX…  : e.g. BOX, BOXALARM, BOX1 (uppercase only)
    CODE_PATTERNS: [
      /\b69-?E-?\d{0,2}[A-Z]?\b/,
      /\b69-?D-?\d{0,2}[A-Z]?\b/,
      /\bDW[A-Z0-9]*\b/,
      /\bBOX[A-Z0-9]*\b/,
    ],
    // Codes that match a pattern above but should be ignored.
    EXCLUDE_CODES: ['DWI'],

    // How to find a "call row". Leave '' for automatic (table rows, list items,
    // grid rows). If you get duplicate/odd alerts, right-click a call in Adashi →
    // Inspect, and put a CSS selector for ONE call row here (e.g. 'tr.incident-row').
    ROW_SELECTOR: '',

    // Pattern used to pull an incident number out of a row, so the same call
    // never texts twice even when its units/status/times change.
    // Default matches things like 2026-001234, 26-12345, F26001234.
    INCIDENT_ID_PATTERN: /\b[A-Z]{0,4}\d{2,4}-?\d{4,8}\b/,

    // ---- Address & units in the alert ----
    // The script finds these automatically: first from table column headers
    // (a column named like "Address"/"Location" or "Units"), then from elements
    // whose class mentions address/location/units, then by pattern matching.
    // If it picks the wrong thing, Inspect the call row in Adashi and put a CSS
    // selector for the address / units element (inside the row) here:
    ADDRESS_SELECTOR: '',
    UNITS_SELECTOR: '',
    // Pattern for a unit ID (E5, T5, M12, BC1, Engine 5, Truck 5…). Uppercase only.
    UNIT_PATTERN: /\b(?:(?:ENGINE|TRUCK|TOWER|LADDER|SQUAD|RESCUE|MEDIC|AMBULANCE|TANKER|BRUSH|CHIEF|BATTALION|UTILITY)\s?\d{1,4}|(?:ENG|TRK|TWR|BATT|BAT|BC|DC|AC|EMS|ATV|TK|TW|SQ|RE|RS|MD|AM|TN|BR|CH|UT|WS|E|T|L|Q|R|M|A|B|C|U)-?\d{1,4})[A-Z]?\b/g,
    // Include the whole call row text as well (useful in case the address or
    // units weren't picked out correctly).
    INCLUDE_ROW_TEXT: true,
    // Units are often assigned after a call first appears. When new units are
    // added, send one follow-up (after the unit list has stopped changing for
    // UNIT_UPDATE_SETTLE_SECONDS). Only for UNIT_UPDATE_MINUTES after the alert.
    SEND_UNIT_UPDATES: true,
    UNIT_UPDATE_SETTLE_SECONDS: 20,
    UNIT_UPDATE_MINUTES: 15,

    // Don't text about calls that are already on screen when the page loads.
    ALERT_ON_CALLS_PRESENT_AT_LOAD: false,

    // Forget calls after this many hours (keeps storage small).
    REMEMBER_HOURS: 24,

    // Also show a desktop notification in Firefox.
    DESKTOP_NOTIFICATION: true,

    // Max characters in one alert message.
    MAX_MESSAGE_CHARS: 500,

    DEBUG: false,
  };
  /* ========================================================================= */

  const STORE_KEY = 'adashiDwellingSeen';
  const ENABLED_KEY = 'adashiDwellingEnabled';
  const log = (...a) => CONFIG.DEBUG && console.log('[Adashi DW alert]', ...a);

  // ---------- persistence of "already alerted" calls ----------
  function loadSeen() {
    let seen = {};
    try { seen = JSON.parse(GM_getValue(STORE_KEY, '{}')) || {}; } catch (e) { seen = {}; }
    const cutoff = Date.now() - CONFIG.REMEMBER_HOURS * 3600 * 1000;
    for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];
    return seen;
  }
  function markSeen(keys) {
    const seen = loadSeen(); // re-read: another tab/frame may have added some
    const now = Date.now();
    for (const k of keys) seen[k] = now;
    GM_setValue(STORE_KEY, JSON.stringify(seen));
  }
  const isEnabled = () => GM_getValue(ENABLED_KEY, true);

  // ---------- detection ----------
  const DEFAULT_ROW_SELECTOR =
    'tr, [role="row"], li, [class*="incident" i], [class*="call-row" i], [class*="callrow" i]';

  function clean(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function findCode(text) {
    for (const re of CONFIG.CODE_PATTERNS) {
      const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
      const g = new RegExp(re.source, flags);
      let m;
      while ((m = g.exec(text)) !== null) {
        if (!CONFIG.EXCLUDE_CODES.includes(m[0].toUpperCase())) return m[0];
        if (m[0].length === 0) g.lastIndex++;
      }
    }
    return null;
  }

  // Strip clock times / elapsed timers so a ticking timer doesn't look like a new call.
  function stableText(text) {
    return text
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/gi, '')
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  function callKey(text, code, address) {
    const id = text.match(CONFIG.INCIDENT_ID_PATTERN);
    if (id) return 'id:' + id[0];
    if (address) return 'addr:' + code + '|' + address.toUpperCase();
    return 'txt:' + code + '|' + stableText(text);
  }

  // ---------- address & units ----------
  const ADDRESS_HEADER = /address|location|\bloc\b/i;
  const UNITS_HEADER = /unit|apparatus|resource|assigned/i;
  const ADDRESS_CLASS = '[class*="address" i], [class*="location" i], [data-field*="address" i], [data-field*="location" i]';
  const UNITS_CLASS = '[class*="units" i], [class*="unit-" i], [class*="assigned" i], [data-field*="unit" i]';
  const STREET_SUFFIX = 'ST|STREET|RD|ROAD|AVE?|AVENUE|DR|DRIVE|LN|LANE|CT|COURT|BLVD|BOULEVARD|HWY|HIGHWAY|PIKE|TPKE|WAY|PL|PLACE|CIR|CIRCLE|TER|TERR|TERRACE|PKWY|PARKWAY|TRL|TRAIL|RTE?|ROUTE|ALY|ALLEY|LOOP|RUN|XING|SQ';
  const ADDRESS_RE = new RegExp(
    '\\b\\d{1,6}[A-Z]?\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z0-9][\\w.\'-]*\\s+){0,4}?(?:' + STREET_SUFFIX +
    ')\\b\\.?(?:\\s+(?:APT|UNIT|STE|LOT|#)\\s*[\\w-]+)?', 'i');

  // Text of the cell under a column whose header matches `re` (tables & ARIA grids).
  function cellByHeader(row, re) {
    let headers = [], cells = [];
    const table = row.closest('table');
    if (row.tagName === 'TR' && table) {
      const hr = table.querySelector('thead tr') || [...table.rows].find((r) => r.querySelector('th'));
      if (hr && hr !== row) headers = [...hr.cells];
      cells = [...row.cells];
    } else if (row.getAttribute('role') === 'row') {
      const grid = row.closest('[role="grid"], [role="table"], [role="treegrid"]');
      if (grid) headers = [...grid.querySelectorAll('[role="columnheader"]')];
      cells = [...row.querySelectorAll('[role="gridcell"], [role="cell"]')];
    }
    const i = headers.findIndex((h) => re.test(clean(h.innerText)));
    return i >= 0 && cells[i] ? clean(cells[i].innerText) : null;
  }

  function stripNoise(text, code) {
    let t = text.replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/gi, ' ')
                .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ');
    const id = t.match(CONFIG.INCIDENT_ID_PATTERN);
    if (id) t = t.replace(id[0], ' ');
    if (code) t = t.split(code).join(' ');
    return t;
  }

  function unitList(text) {
    const re = new RegExp(CONFIG.UNIT_PATTERN.source, CONFIG.UNIT_PATTERN.flags.includes('g') ? CONFIG.UNIT_PATTERN.flags : CONFIG.UNIT_PATTERN.flags + 'g');
    return [...new Set((text.match(re) || []).map((u) => u.replace(/\s+/g, ' ')))];
  }

  function extractFields(row, text, code) {
    const pick = (sel) => { const el = sel && row.querySelector(sel); return el ? clean(el.innerText) : null; };

    let address = pick(CONFIG.ADDRESS_SELECTOR) || cellByHeader(row, ADDRESS_HEADER) || pick(ADDRESS_CLASS);
    if (!address) {
      const m = stripNoise(text, code).match(ADDRESS_RE);
      address = m ? clean(m[0]) : '';
    }

    const unitsText = pick(CONFIG.UNITS_SELECTOR) || cellByHeader(row, UNITS_HEADER) || pick(UNITS_CLASS);
    let units;
    if (unitsText != null) {
      units = unitList(unitsText);
      if (!units.length && unitsText) units = unitsText.split(/[,;\s]+/).filter(Boolean);
    } else {
      let rest = stripNoise(text, code);
      if (address) rest = rest.split(address).join(' ');
      units = unitList(rest);
    }
    return { address, units };
  }

  function scan() {
    const selector = CONFIG.ROW_SELECTOR || DEFAULT_ROW_SELECTOR;
    const rows = document.querySelectorAll(selector);
    const found = new Map(); // key -> {code, text, address, units}
    rows.forEach((row) => {
      const text = clean(row.innerText);
      if (!text || text.length > 2000) return;
      const code = findCode(text);
      if (!code) return;
      // Skip wrappers: if a smaller row inside this one also matches, use that instead.
      const inner = row.querySelectorAll(selector);
      for (const child of inner) if (findCode(clean(child.innerText))) return;
      const { address, units } = extractFields(row, text, code);
      const key = callKey(text, code, address);
      const prev = found.get(key);
      // Prefer the smallest element (the actual row, not a wrapper).
      if (!prev || text.length < prev.text.length) found.set(key, { code, text, address, units });
    });
    return found;
  }

  // ---------- sending ----------
  function request(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r) : reject(new Error(r.status + ' ' + r.responseText))),
        onerror: (r) => reject(new Error('network error ' + (r && r.error ? r.error : ''))),
        ontimeout: () => reject(new Error('timeout')),
        timeout: 20000,
      });
    });
  }
  const form = (obj) =>
    Object.entries(obj).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  async function sendAlert(message, opts = {}) {
    const title = opts.title || 'Fire call';
    const priority = opts.priority || 'urgent';
    const p = CONFIG.PROVIDER;
    if (p === 'twilio') {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json`;
      const auth = 'Basic ' + btoa(CONFIG.TWILIO_ACCOUNT_SID + ':' + CONFIG.TWILIO_AUTH_TOKEN);
      await Promise.all(CONFIG.TO_NUMBERS.map((to) => request({
        method: 'POST', url,
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        data: form({ To: to, From: CONFIG.TWILIO_FROM, Body: message }),
      })));
    } else if (p === 'ntfy') {
      await request({
        method: 'POST',
        url: 'https://ntfy.sh/' + encodeURIComponent(CONFIG.NTFY_TOPIC),
        headers: { Title: title, Priority: priority, Tags: 'fire' },
        data: message,
      });
    } else if (p === 'textbelt') {
      await Promise.all(CONFIG.TO_NUMBERS.map(async (to) => {
        const r = await request({
          method: 'POST', url: 'https://textbelt.com/text',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          data: form({ phone: to, message, key: CONFIG.TEXTBELT_KEY }),
        });
        const j = JSON.parse(r.responseText);
        if (!j.success) throw new Error('Textbelt: ' + (j.error || r.responseText));
      }));
    } else {
      throw new Error('Unknown PROVIDER: ' + p);
    }
  }

  function buildMessage(c, update) {
    const lines = [
      update ? `UNITS UPDATE (${c.code})` : `FIRE CALL (${c.code})`,
      'Address: ' + (c.address || 'not found (see below)'),
      'Units: ' + (c.units.length ? c.units.join(', ') : 'none assigned yet'),
    ];
    if (CONFIG.INCLUDE_ROW_TEXT && !update) lines.push('', c.text);
    let body = lines.join('\n');
    if (body.length > CONFIG.MAX_MESSAGE_CHARS) body = body.slice(0, CONFIG.MAX_MESSAGE_CHARS - 1) + '…';
    return body;
  }

  async function alertCall(c, update = false) {
    const msg = buildMessage(c, update);
    const title = update ? 'Units update' : 'Fire call';
    log(update ? 'UPDATE' : 'ALERT', msg);
    if (CONFIG.DESKTOP_NOTIFICATION) {
      try { GM_notification({ title, text: msg, timeout: 15000 }); } catch (e) { /* ignore */ }
    }
    try {
      await sendAlert(msg, { title, priority: update ? 'high' : 'urgent' });
      log('sent');
    } catch (e) {
      console.error('[Adashi DW alert] Failed to send alert:', e);
    }
  }

  // ---------- follow-up when units get assigned ----------
  const tracked = new Map(); // key -> {call, sentUnits:Set, until, timer}

  function track(key, call) {
    if (!CONFIG.SEND_UNIT_UPDATES) return;
    tracked.set(key, { call, sentUnits: new Set(call.units), until: Date.now() + CONFIG.UNIT_UPDATE_MINUTES * 60000, timer: null });
  }

  function updateTracked(found) {
    const now = Date.now();
    for (const [key, t] of tracked) {
      if (now > t.until) { clearTimeout(t.timer); tracked.delete(key); continue; }
      const cur = found.get(key);
      if (!cur || cur.units.join(',') === t.call.units.join(',')) continue;
      t.call = { ...cur, address: cur.address || t.call.address };
      clearTimeout(t.timer);
      t.timer = setTimeout(() => {
        const added = t.call.units.filter((u) => !t.sentUnits.has(u));
        if (!added.length) return;
        t.call.units.forEach((u) => t.sentUnits.add(u));
        alertCall(t.call, true);
      }, CONFIG.UNIT_UPDATE_SETTLE_SECONDS * 1000);
    }
  }

  // ---------- main loop ----------
  let firstScan = true;
  function check() {
    if (!isEnabled()) return;
    const found = scan();
    updateTracked(found);
    const seen = loadSeen();
    const fresh = [...found].filter(([k]) => !seen[k]);
    if (!fresh.length) { firstScan = false; return; }
    markSeen(fresh.map(([k]) => k)); // mark first so a re-scan can't double-send
    if (firstScan && !CONFIG.ALERT_ON_CALLS_PRESENT_AT_LOAD) {
      log('baseline: ignoring', fresh.length, 'call(s) already on screen');
    } else {
      fresh.forEach(([k, v]) => { alertCall(v); track(k, v); });
    }
    firstScan = false;
  }

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(check, 750); };

  // Give the app a moment to render its call list before the baseline scan.
  setTimeout(() => {
    check();
    new MutationObserver(schedule).observe(document.body, {
      childList: true, subtree: true, characterData: true,
    });
    setInterval(check, 10000); // safety net
  }, 5000);

  // ---------- Tampermonkey menu ----------
  GM_registerMenuCommand('Send test alert', () => {
    sendAlert('TEST: Adashi dwelling fire alerts are working.')
      .then(() => alert('Test alert sent.'))
      .catch((e) => alert('Test failed: ' + e.message));
  });
  GM_registerMenuCommand('Show matching calls on screen', () => {
    const found = scan();
    alert(found.size ? [...found.values()].map((v) => buildMessage(v, false)).join('\n\n----------\n\n')
                     : 'No matching calls found on this page.');
  });
  GM_registerMenuCommand('Pause / resume alerts', () => {
    GM_setValue(ENABLED_KEY, !isEnabled());
    alert('Alerts are now ' + (isEnabled() ? 'ON' : 'PAUSED'));
  });
  GM_registerMenuCommand('Forget alerted calls', () => {
    GM_setValue(STORE_KEY, '{}');
    firstScan = true; // re-baseline: calls on screen now won't text
    alert('Cleared. Calls currently on screen will not text; only new ones will.');
  });

  log('loaded');
})();
