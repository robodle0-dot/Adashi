// ==UserScript==
// @name         Adashi Dwelling Fire Text Alert
// @namespace    adashi-dwelling-fire-alert
// @version      1.6.0
// @description  Alerts your phone the first time a fire call (69E* / 69D* / DW*) appears in Adashi, with its address.
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

    // Call-type patterns. A call alerts if ANY of these match.
    //   69E… / 69D… : 69E or 69D followed by any letters/digits (usually 5
    //                 characters total, e.g. 69E01, 69D06, 69EA1; up to 6 allowed).
    //                 Addresses like "69 E Main St" or "69 D St" are NOT matched.
    //   DW…   : e.g. DW, DWF, DWELL, DWELLING (uppercase only)
    CODE_PATTERNS: [
      /\b69[ED][A-Z0-9]{0,3}\b/,
      /\bDW[A-Z0-9]*\b/,
    ],
    // Codes that match a pattern above but should be ignored.
    EXCLUDE_CODES: ['DWI'],

    // The address is read from the text that comes right after the call code on
    // the page. It skips past timers, ID numbers and short descriptions (like
    // "STRUCTURE FIRE") and takes the first piece that looks like an address,
    // looking at most ADDRESS_LOOKAHEAD pieces ahead.
    ADDRESS_LOOKAHEAD: 5,
    // If it still picks the wrong text: right-click the address in Adashi →
    // Inspect, and put a CSS selector for the address element here
    // (it is searched for inside the call's row). Leave '' for automatic.
    ADDRESS_SELECTOR: '',

    // How to find a "call row" (used to tell calls apart). Leave '' for
    // automatic. Only change this if you get duplicate alerts.
    ROW_SELECTOR: '',

    // Pattern used to pull an incident number out of a row, so the same call
    // never alerts twice even when its status/times change.
    // Default matches things like 2026-001234, 26-12345, F26001234.
    INCIDENT_ID_PATTERN: /\b[A-Z]{0,4}\d{2,4}-?\d{4,8}\b/,

    // Don't alert about calls that are already on screen when the page loads.
    ALERT_ON_CALLS_PRESENT_AT_LOAD: false,

    // Only alert for calls whose time on the page (e.g. 15:54:49) is within
    // this many minutes of now. This stops alerts for old calls when you
    // switch to the "Closed" tab or change filters. 0 = no limit.
    MAX_CALL_AGE_MINUTES: 30,

    // Forget calls after this many hours (keeps storage small).
    REMEMBER_HOURS: 24,

    // Also show a desktop notification in Firefox.
    DESKTOP_NOTIFICATION: true,

    // Max characters in one alert message.
    MAX_MESSAGE_CHARS: 300,

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

  // ---------- helpers ----------
  const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();

  function findCode(text) {
    for (const re of CONFIG.CODE_PATTERNS) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = g.exec(text)) !== null) {
        if (!CONFIG.EXCLUDE_CODES.includes(m[0].toUpperCase())) return m;
        if (m[0].length === 0) g.lastIndex++;
      }
    }
    return null;
  }

  // Visible text pieces (text nodes) of the page, in reading order.
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION']);
  function textWalker(root) {
    return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const el = node.parentElement;
        if (!el || SKIP_TAGS.has(el.tagName) || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (el.checkVisibility && !el.checkVisibility()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
  }

  // ---------- address ----------
  const STREET_SUFFIX = 'ST|STREET|RD|ROAD|AVE?|AVENUE|DR|DRIVE|LN|LANE|CT|COURT|BLVD|BOULEVARD|HWY|HIGHWAY|PIKE|TPKE|WAY|PL|PLACE|CIR|CIRCLE|TER|TERR|TERRACE|PKWY|PARKWAY|TRL|TRAIL|RTE?|ROUTE|ALY|ALLEY|LOOP|RUN|XING|SQ';
  const HAS_SUFFIX = new RegExp('\\b(?:' + STREET_SUFFIX + ')\\b\\.?', 'i');
  const HOUSE_NUMBER = /^\d{1,6}[A-Z]?(?:-\d+)?\s+(?:[NSEW]\.?\s+)?[A-Za-z]{2,}/; // "123 MAIN", "412 N OAK"
  const ROUTE = /\b(?:RT|RTE|ROUTE|SR|US|HWY|I)[ -]?\d{1,4}\b/i;
  const INTERSECTION = /\S\s*[/&@]\s*\S/;
  const NOT_ADDRESS = /^[\d\s:\/.,-]*(?:AM|PM)?$/i; // timers, dates, bare numbers

  // Trim leading separators like " - ", ": ", "| " off a piece of text.
  const trimSep = (t) => clean(t).replace(/^[\s\-–—:|,;>•·]+/, '').replace(/[\s\-–—:|,;]+$/, '');

  function looksLikeAddress(t) {
    if (!t || t.length > 120 || NOT_ADDRESS.test(t)) return false;
    if (CONFIG.INCIDENT_ID_PATTERN.test(t) && clean(t.replace(CONFIG.INCIDENT_ID_PATTERN, '')) === '') return false;
    return HOUSE_NUMBER.test(t) || HAS_SUFFIX.test(t) || ROUTE.test(t) || INTERSECTION.test(t);
  }

  // Text pieces that come right after the call code (same text node first).
  function piecesAfter(node, match) {
    const pieces = [];
    const rest = trimSep(node.nodeValue.slice(match.index + match[0].length));
    if (rest) pieces.push(rest);
    const w = textWalker(document.body);
    w.currentNode = node;
    let n;
    while (pieces.length < CONFIG.ADDRESS_LOOKAHEAD && (n = w.nextNode())) {
      const t = trimSep(n.nodeValue);
      if (t) pieces.push(t);
    }
    return pieces.slice(0, CONFIG.ADDRESS_LOOKAHEAD);
  }

  function findAddress(row, pieces) {
    if (CONFIG.ADDRESS_SELECTOR && row) {
      const el = row.querySelector(CONFIG.ADDRESS_SELECTOR);
      if (el && clean(el.innerText)) return clean(el.innerText);
    }
    return pieces.find(looksLikeAddress) || '';
  }

  // Fallback: the first piece of text anywhere in the row that looks like an address.
  function rowAddress(row) {
    const w = textWalker(row);
    let n;
    while ((n = w.nextNode())) {
      const t = trimSep(n.nodeValue);
      if (looksLikeAddress(t) && !findCode(t)) return t;
    }
    return '';
  }

  // Minutes since the call's time shown in its row (first HH:MM or HH:MM:SS),
  // or null if the row shows no time.
  function callAgeMinutes(rowText) {
    const m = rowText.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/);
    if (!m) return null;
    const now = new Date();
    const t = new Date(now);
    t.setHours(+m[1], +m[2], +(m[3] || 0), 0);
    let mins = (now - t) / 60000;
    if (mins < -10) mins += 24 * 60; // time is from yesterday (shortly before midnight)
    return mins;
  }

  // ---------- rows & detection ----------
  const STRONG_ROW = 'tr, [role="row"], li';

  function findRow(el, address) {
    let row = (CONFIG.ROW_SELECTOR && el.closest(CONFIG.ROW_SELECTOR)) || el.closest(STRONG_ROW);
    if (row) return row;
    // No obvious row element: climb until the element holds the address too
    // (or at least some text beyond the code), without growing too large.
    row = el;
    for (let i = 0; i < 8 && row.parentElement && row.parentElement !== document.body; i++) {
      const text = clean(row.innerText);
      if (address ? text.includes(address) : text.length > 40) break;
      const up = clean(row.parentElement.innerText);
      if (up.length > 1500) break;
      row = row.parentElement;
    }
    return row;
  }

  // The row's visible text, with a space between each piece.
  function rowText(row) {
    const parts = [];
    const w = textWalker(row);
    let n;
    while ((n = w.nextNode())) parts.push(n.nodeValue);
    return clean(parts.join(' ')).slice(0, 2000);
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

  function callKey(rowText, code, address) {
    const id = rowText.match(CONFIG.INCIDENT_ID_PATTERN);
    if (id) return 'id:' + id[0];
    if (address) return 'addr:' + code + '|' + address.toUpperCase();
    return 'txt:' + code + '|' + stableText(rowText);
  }

  function scan() {
    const found = new Map(); // key -> {code, address, text, pieces}
    const w = textWalker(document.body);
    let node;
    while ((node = w.nextNode())) {
      const m = findCode(node.nodeValue);
      if (!m) continue;
      // Ignore codes that are really part of an address ("DWIGHT AVE", "DWYER RD").
      if (looksLikeAddress(clean(node.nodeValue))) continue;
      const pieces = piecesAfter(node, m);
      const roughRow = findRow(node.parentElement, '');
      let address = findAddress(roughRow, pieces);
      const row = findRow(node.parentElement, address);
      if (!address) address = findAddress(row, []) || rowAddress(row);
      const text = rowText(row);
      const key = callKey(text, m[0], address);
      const prev = found.get(key);
      if (!prev || (!prev.address && address)) found.set(key, { code: m[0], address, text, pieces });
    }
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

  async function sendAlert(message) {
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
        headers: { Title: 'Fire call', Priority: 'urgent', Tags: 'fire' },
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

  function buildMessage(c) {
    // If no address was recognised, include the call's text so nothing is lost.
    let body = c.address
      ? `FIRE CALL (${c.code})\n${c.address}`
      : `FIRE CALL (${c.code})\nAddress not recognized: ${c.text}`;
    if (body.length > CONFIG.MAX_MESSAGE_CHARS) body = body.slice(0, CONFIG.MAX_MESSAGE_CHARS - 1) + '…';
    return body;
  }

  async function alertCall(c) {
    const msg = buildMessage(c);
    log('ALERT', msg);
    if (CONFIG.DESKTOP_NOTIFICATION) {
      try { GM_notification({ title: 'Fire call', text: msg, timeout: 15000 }); } catch (e) { /* ignore */ }
    }
    try {
      await sendAlert(msg);
      log('sent');
    } catch (e) {
      console.error('[Adashi DW alert] Failed to send alert:', e);
    }
  }

  // ---------- main loop ----------
  let firstScan = true;
  function check() {
    if (!isEnabled()) return;
    const found = scan();
    const seen = loadSeen();
    const fresh = [...found].filter(([k]) => !seen[k]);
    if (!fresh.length) { firstScan = false; return; }
    markSeen(fresh.map(([k]) => k)); // mark first so a re-scan can't double-send
    if (firstScan && !CONFIG.ALERT_ON_CALLS_PRESENT_AT_LOAD) {
      log('baseline: ignoring', fresh.length, 'call(s) already on screen');
    } else {
      fresh.forEach(([, v]) => {
        const age = callAgeMinutes(v.text);
        if (CONFIG.MAX_CALL_AGE_MINUTES && age !== null && age > CONFIG.MAX_CALL_AGE_MINUTES) {
          log('skipping old call', v.code, v.address, Math.round(age) + ' min old');
          return;
        }
        alertCall(v);
      });
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
    sendAlert('TEST: Adashi fire call alerts are working.')
      .then(() => alert('Test alert sent.'))
      .catch((e) => alert('Test failed: ' + e.message));
  });
  GM_registerMenuCommand('Show matching calls on screen', () => {
    const found = scan();
    alert(found.size
      ? [...found.values()].map((v) =>
          buildMessage(v) + '\n\n[text after code: ' + v.pieces.map((p) => `"${p}"`).join(', ') + ']'
        ).join('\n\n----------\n\n')
      : 'No matching calls found on this page.');
  });
  GM_registerMenuCommand('Pause / resume alerts', () => {
    GM_setValue(ENABLED_KEY, !isEnabled());
    alert('Alerts are now ' + (isEnabled() ? 'ON' : 'PAUSED'));
  });
  GM_registerMenuCommand('Forget alerted calls', () => {
    GM_setValue(STORE_KEY, '{}');
    firstScan = true; // re-baseline: calls on screen now won't alert
    alert('Cleared. Calls currently on screen will not alert; only new ones will.');
  });

  log('loaded');
})();
