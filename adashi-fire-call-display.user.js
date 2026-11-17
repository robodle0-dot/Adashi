// ==UserScript==
// @name         Adashi Fire Call TV Display
// @namespace    adashi-fire-call-display
// @version      1.1.0
// @description  When a new fire call (69E* / 69D* / DW*) comes in, shows it in big text on the Adashi screen for about a minute, sounds an alarm and reads the call aloud.
// @author       you
// @match        https://live.adashi.com/bcfd/apps/AdashiNotify/app/incidents*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* =========================================================================
   *  SETTINGS — edit this block
   * ========================================================================= */
  const CONFIG = {
    // Call-type patterns. A call is shown if ANY of these match its row text.
    //   69E… / 69D… : MPDS Protocol 69 Echo/Delta (e.g. 69E01, 69-D-6).
    //                 Addresses like "69 E Main St" or "69 D St" are NOT matched.
    //   DW…   : e.g. DW, DWF, DWELL, DWELLING (uppercase only)
    CODE_PATTERNS: [
      /\b69-?E-?\d{0,2}[A-Z]?\b/,
      /\b69-?D-?\d{0,2}[A-Z]?\b/,
      /\bDW[A-Z0-9]*\b/,
    ],
    // Codes that match a pattern above but should be ignored.
    EXCLUDE_CODES: ['DWI'],

    // Only show calls whose row also contains PENDING_PATTERN (e.g. a status
    // column that says "Pending"). false = show every matching call on screen.
    PENDING_ONLY: false,
    PENDING_PATTERN: /\bPEND(ING)?\b/i,

    // How to find a "call row". Leave '' for automatic. If calls show up twice
    // or not at all, right-click a call in Adashi → Inspect, and put a CSS
    // selector for ONE call row here (e.g. 'tr.incident-row').
    ROW_SELECTOR: '',
    // Pattern for the incident number, so each call is recognised as the same
    // call even when its units/status/times change.
    INCIDENT_ID_PATTERN: /\b[A-Z]{0,4}\d{2,4}-?\d{4,8}\b/,

    // Found automatically from column headers / element names / patterns.
    // If they come out wrong, put CSS selectors (inside the row) here.
    ADDRESS_SELECTOR: '',
    UNITS_SELECTOR: '',
    CALL_TYPE_SELECTOR: '',
    UNIT_PATTERN: /\b(?:(?:ENGINE|TRUCK|TOWER|LADDER|SQUAD|RESCUE|MEDIC|AMBULANCE|TANKER|BRUSH|CHIEF|BATTALION|UTILITY)\s?\d{1,4}|(?:ENG|TRK|TWR|BATT|BAT|BC|DC|AC|EMS|ATV|TK|TW|SQ|RE|RS|MD|AM|TN|BR|CH|UT|WS|E|T|L|Q|R|M|A|B|C|U)-?\d{1,4})[A-Z]?\b/g,

    // ---- On-screen display ----
    SHOW_BANNER: true,          // big banner when a new fire call comes in
    BANNER_SECONDS: 60,         // banner closes by itself after this long (or when ACKNOWLEDGE is clicked)
    BANNER_POSITION: 'top',     // 'top' or 'bottom'
    TEXT_SIZE: 1,               // 1 = default; 1.5 = 50% bigger; 0.8 = smaller
    HIGHLIGHT_ROWS: true,       // also highlight fire calls' rows in Adashi's list (stays while the call is listed)
    ROW_TEXT_SCALE: 1.3,        // make highlighted rows' text this much bigger (1 = no change)

    // ---- Sound ----
    SOUND: true,                // alarm tone for new calls
    SPEAK: true,                // read the code and address aloud after the tone
    VOLUME: 0.8,                // 0.0 – 1.0
    TONE_SECONDS: 4,            // length of the alarm tone
    REPEAT_EVERY_SECONDS: 30,   // while the banner is up, repeat the alarm this often…
    REPEAT_TIMES: 1,            // …up to this many extra times (0 = play once)
    SPEECH_RATE: 0.95,
    // Alert (banner + sound) for calls that are already on screen when the page loads?
    SOUND_FOR_CALLS_AT_LOAD: false,

    REMEMBER_HOURS: 24,
    DEBUG: false,
  };
  /* ========================================================================= */

  const STORE_KEY = 'adashiDisplaySeen';
  const ENABLED_KEY = 'adashiDisplaySoundOn';
  const PREFIX = 'adfd';
  const log = (...a) => CONFIG.DEBUG && console.log('[Adashi display]', ...a);

  // ---------- persistence of "already announced" calls ----------
  function loadSeen() {
    let seen = {};
    try { seen = JSON.parse(GM_getValue(STORE_KEY, '{}')) || {}; } catch (e) { seen = {}; }
    const cutoff = Date.now() - CONFIG.REMEMBER_HOURS * 3600 * 1000;
    for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];
    return seen;
  }
  function markSeen(keys) {
    const seen = loadSeen();
    const now = Date.now();
    for (const k of keys) seen[k] = now;
    GM_setValue(STORE_KEY, JSON.stringify(seen));
  }
  const soundOn = () => GM_getValue(ENABLED_KEY, true);

  // ---------- detection ----------
  const DEFAULT_ROW_SELECTOR =
    'tr, [role="row"], li, [class*="incident" i], [class*="call-row" i], [class*="callrow" i]';
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();

  function findCode(text) {
    for (const re of CONFIG.CODE_PATTERNS) {
      const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let m;
      while ((m = g.exec(text)) !== null) {
        if (!CONFIG.EXCLUDE_CODES.includes(m[0].toUpperCase())) return m[0];
        if (m[0].length === 0) g.lastIndex++;
      }
    }
    return null;
  }

  function stableText(text) {
    return text
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b/gi, '')
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '')
      .replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function callKey(text, code, address) {
    const id = text.match(CONFIG.INCIDENT_ID_PATTERN);
    if (id) return 'id:' + id[0];
    if (address) return 'addr:' + code + '|' + address.toUpperCase();
    return 'txt:' + code + '|' + stableText(text);
  }

  const ADDRESS_HEADER = /address|location|\bloc\b/i;
  const UNITS_HEADER = /unit|apparatus|resource|assigned/i;
  const TYPE_HEADER = /type|nature|desc|complaint|problem|incident\s*code|call\s*code/i;
  const ADDRESS_CLASS = '[class*="address" i], [class*="location" i], [data-field*="address" i], [data-field*="location" i]';
  const UNITS_CLASS = '[class*="units" i], [class*="unit-" i], [class*="assigned" i], [data-field*="unit" i]';
  const TYPE_CLASS = '[class*="type" i], [class*="nature" i], [class*="desc" i], [data-field*="type" i]';
  const STREET_SUFFIX = 'ST|STREET|RD|ROAD|AVE?|AVENUE|DR|DRIVE|LN|LANE|CT|COURT|BLVD|BOULEVARD|HWY|HIGHWAY|PIKE|TPKE|WAY|PL|PLACE|CIR|CIRCLE|TER|TERR|TERRACE|PKWY|PARKWAY|TRL|TRAIL|RTE?|ROUTE|ALY|ALLEY|LOOP|RUN|XING|SQ';
  const ADDRESS_RE = new RegExp(
    '\\b\\d{1,6}[A-Z]?\\s+(?:[NSEW]\\.?\\s+)?(?:[A-Z0-9][\\w.\'-]*\\s+){0,4}?(?:' + STREET_SUFFIX +
    ')\\b\\.?(?:\\s+(?:APT|UNIT|STE|LOT|#)\\s*[\\w-]+)?', 'i');

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
    const f = CONFIG.UNIT_PATTERN.flags;
    const re = new RegExp(CONFIG.UNIT_PATTERN.source, f.includes('g') ? f : f + 'g');
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

    let callType = pick(CONFIG.CALL_TYPE_SELECTOR) || cellByHeader(row, TYPE_HEADER) || pick(TYPE_CLASS) || '';
    callType = clean(callType.split(code).join(' ')).replace(/^[-–:\s]+|[-–:\s]+$/g, '');
    if (callType.length > 60) callType = '';
    return { address, units, callType };
  }

  const isOurs = (el) => !!(el.closest && el.closest(`.${PREFIX}-ui`));

  function scan() {
    const selector = CONFIG.ROW_SELECTOR || DEFAULT_ROW_SELECTOR;
    const found = new Map(); // key -> {code, text, address, units, callType, row}
    document.querySelectorAll(selector).forEach((row) => {
      if (isOurs(row)) return;
      const text = clean(row.innerText);
      if (!text || text.length > 2000) return;
      const code = findCode(text);
      if (!code) return;
      if (CONFIG.PENDING_ONLY && !CONFIG.PENDING_PATTERN.test(text)) return;
      for (const child of row.querySelectorAll(selector)) if (findCode(clean(child.innerText))) return;
      const fields = extractFields(row, text, code);
      const key = callKey(text, code, fields.address);
      const prev = found.get(key);
      if (!prev || text.length < prev.text.length) found.set(key, { code, text, row, ...fields });
    });
    return found;
  }

  // ---------- styles ----------
  const S = CONFIG.TEXT_SIZE;
  const css = `
    .${PREFIX}-banner{position:fixed;left:0;right:0;${CONFIG.BANNER_POSITION === 'bottom' ? 'bottom' : 'top'}:0;z-index:2147483646;
      background:#1a0000;color:#fff;font-family:Arial,Helvetica,sans-serif;box-shadow:0 0 24px rgba(0,0,0,.6);
      border:6px solid #ff1a1a;max-height:70vh;overflow:auto}
    .${PREFIX}-head{display:flex;align-items:center;gap:12px;padding:6px 14px;background:#c00000;
      font-size:${1.6 * S}vw;font-weight:bold;letter-spacing:.05em}
    .${PREFIX}-head span{flex:1}
    .${PREFIX}-btn{font:inherit;font-size:${1.1 * S}vw;font-weight:bold;padding:4px 14px;border:3px solid #fff;
      background:#fff;color:#c00000;border-radius:6px;cursor:pointer}
    .${PREFIX}-btn.${PREFIX}-ghost{background:transparent;color:#fff}
    .${PREFIX}-call{padding:10px 18px;border-top:3px solid #ff1a1a}
    .${PREFIX}-call.${PREFIX}-new{animation:${PREFIX}-flash 1s steps(1) infinite}
    @keyframes ${PREFIX}-flash{0%{background:#ffea00;color:#000}50%{background:#1a0000;color:#fff}}
    .${PREFIX}-l1{font-size:${2.6 * S}vw;font-weight:bold;line-height:1.15}
    .${PREFIX}-code{display:inline-block;background:#ff1a1a;color:#fff;padding:0 .3em;margin-right:.4em;border-radius:.15em}
    .${PREFIX}-addr{font-size:${4.2 * S}vw;font-weight:900;line-height:1.1;text-transform:uppercase}
    .${PREFIX}-units{font-size:${2 * S}vw;margin-top:2px}
    .${PREFIX}-row{outline:4px solid #ff1a1a !important;outline-offset:-4px;background:#fff3a0 !important;
      color:#000 !important;font-weight:bold !important;${CONFIG.ROW_TEXT_SCALE !== 1 ? `font-size:${CONFIG.ROW_TEXT_SCALE * 100}% !important;` : ''}}
    .${PREFIX}-row *{background:transparent !important;color:#000 !important}
    .${PREFIX}-row.${PREFIX}-rownew{animation:${PREFIX}-rowflash 1s steps(1) infinite}
    @keyframes ${PREFIX}-rowflash{0%{background:#ff4040 !important}50%{background:#fff3a0 !important}}
    .${PREFIX}-unlock{position:fixed;right:16px;bottom:16px;z-index:2147483647;font:bold 22px Arial,sans-serif;
      padding:14px 20px;background:#c00000;color:#fff;border:4px solid #fff;border-radius:10px;cursor:pointer;
      box-shadow:0 0 18px rgba(0,0,0,.6)}`;
  const style = document.createElement('style');
  style.className = `${PREFIX}-ui`;
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- sound ----------
  let audioCtx = null;
  let unlocked = false;
  let unlockBtn = null;

  function unlockAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx && AC) audioCtx = new AC();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      if (window.speechSynthesis) {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
      }
      unlocked = true;
      if (unlockBtn) { unlockBtn.remove(); unlockBtn = null; }
      log('audio unlocked');
    } catch (e) { console.error('[Adashi display] audio unlock failed', e); }
  }

  function showUnlockButton() {
    if (!(CONFIG.SOUND || CONFIG.SPEAK) || unlocked || unlockBtn) return;
    unlockBtn = document.createElement('button');
    unlockBtn.className = `${PREFIX}-ui ${PREFIX}-unlock`;
    unlockBtn.textContent = '🔊 Click here to turn on fire call sound';
    unlockBtn.addEventListener('click', (e) => { e.stopPropagation(); unlockAudio(); });
    document.body.appendChild(unlockBtn);
  }
  // Browsers only allow sound after someone clicks or presses a key on the page.
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) =>
    window.addEventListener(ev, () => { if (!unlocked) unlockAudio(); }, { capture: true, passive: true }));

  function playTone() {
    if (!CONFIG.SOUND || !audioCtx) return Promise.resolve();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const t0 = audioCtx.currentTime + 0.05;
    const gain = audioCtx.createGain();
    gain.gain.value = CONFIG.VOLUME * 0.5;
    gain.connect(audioCtx.destination);
    currentTone = gain;
    const step = 0.35; // hi-lo alternating alarm
    const n = Math.max(1, Math.round(CONFIG.TONE_SECONDS / step));
    for (let i = 0; i < n; i++) {
      const osc = audioCtx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = i % 2 ? 620 : 960;
      osc.connect(gain);
      osc.start(t0 + i * step);
      osc.stop(t0 + i * step + step * 0.92);
    }
    return new Promise((r) => setTimeout(r, n * step * 1000 + 300));
  }

  const SPOKEN_WORDS = {
    N: 'North', S: 'South', E: 'East', W: 'West', NE: 'Northeast', NW: 'Northwest', SE: 'Southeast', SW: 'Southwest',
    ST: 'Street', RD: 'Road', AVE: 'Avenue', AV: 'Avenue', DR: 'Drive', LN: 'Lane', CT: 'Court', BLVD: 'Boulevard',
    HWY: 'Highway', PL: 'Place', CIR: 'Circle', TER: 'Terrace', PKWY: 'Parkway', TRL: 'Trail', RT: 'Route',
    RTE: 'Route', APT: 'Apartment', STE: 'Suite', TPKE: 'Turnpike',
  };
  function speakCode(code) {
    const c = code.toUpperCase().replace(/-/g, '');
    const m = c.match(/^69([ED])(\d*)([A-Z]?)$/);
    if (m) return [69, m[1] === 'E' ? 'Echo' : 'Delta', m[2] ? parseInt(m[2], 10) : '', m[3]].filter((x) => x !== '').join(' ');
    if (c.startsWith('DW')) return 'Dwelling fire';
    return c.split('').join(' ');
  }
  const speakAddress = (a) => a.replace(/\b([A-Z]{1,4})\b\.?/gi, (w, x) => SPOKEN_WORDS[x.toUpperCase()] || w);

  function speak(text) {
    if (!CONFIG.SPEAK || !window.speechSynthesis) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = CONFIG.SPEECH_RATE;
      u.volume = CONFIG.VOLUME;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
      setTimeout(resolve, 20000);
    });
  }

  let currentTone = null; // so ACKNOWLEDGE can cut the tone off
  let ackCount = 0;        // bumps on ACKNOWLEDGE so a running announcement stops
  function stopSound() {
    ackCount++;
    if (currentTone) { try { currentTone.disconnect(); } catch (e) { /* ignore */ } currentTone = null; }
    if (window.speechSynthesis) speechSynthesis.cancel();
  }

  let playing = false;
  async function announce(calls) {
    if (!soundOn()) return;
    if (!unlocked) { showUnlockButton(); return; }
    if (playing) return;
    playing = true;
    const myAck = ackCount;
    try {
      await playTone();
      for (const c of calls) {
        if (ackCount !== myAck) break;
        const parts = ['Fire call', speakCode(c.code)];
        if (c.callType) parts.push(c.callType);
        if (c.address) parts.push(speakAddress(c.address));
        await speak(parts.join('. ') + '.');
      }
    } finally { playing = false; }
  }

  // ---------- display ----------
  const state = new Map(); // key -> {call, firstSeen, newUntil, acked, repeatsLeft, nextRepeat}
  let banner = null, listEl = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureBanner() {
    if (banner) return;
    banner = el('div', `${PREFIX}-ui ${PREFIX}-banner`);
    const head = el('div', `${PREFIX}-head`);
    const title = el('span', null, '🔥 FIRE CALL');
    const ack = el('button', `${PREFIX}-btn`, 'ACKNOWLEDGE');
    ack.title = 'Stop the sound and close this banner';
    ack.addEventListener('click', acknowledgeAll);
    head.append(title, ack);
    listEl = el('div');
    banner.append(head, listEl);
    banner._title = title;
    document.body.appendChild(banner);
  }

  function acknowledgeAll() {
    for (const s of state.values()) { s.acked = true; s.newUntil = 0; s.repeatsLeft = 0; }
    stopSound();
    render();
  }

  let lastRender = '';
  function render() {
    const now = Date.now();
    const calls = [...state.values()].sort((a, b) => b.firstSeen - a.firstSeen);

    // highlight rows in Adashi's own list
    document.querySelectorAll(`.${PREFIX}-row`).forEach((r) => {
      if (![...state.values()].some((s) => s.call.row === r)) r.classList.remove(`${PREFIX}-row`, `${PREFIX}-rownew`);
    });
    if (CONFIG.HIGHLIGHT_ROWS) {
      for (const s of calls) {
        s.call.row.classList.add(`${PREFIX}-row`);
        s.call.row.classList.toggle(`${PREFIX}-rownew`, s.newUntil > now);
      }
    }

    if (!CONFIG.SHOW_BANNER) return;
    // The banner only shows calls whose alert is still running (BANNER_SECONDS).
    const alerting = calls.filter((s) => s.newUntil > now);
    if (!alerting.length) {
      if (banner) { banner.remove(); banner = null; lastRender = ''; }
      return;
    }
    ensureBanner();
    const sig = JSON.stringify(alerting.map((s) => [s.call.code, s.call.callType, s.call.address, s.call.units]));
    if (sig === lastRender) return; // nothing changed; don't touch the DOM
    lastRender = sig;

    banner._title.textContent = `🔥 FIRE CALL${alerting.length > 1 ? 'S (' + alerting.length + ')' : ''}`;
    listEl.replaceChildren(...alerting.map((s) => {
      const c = s.call;
      const box = el('div', `${PREFIX}-call ${PREFIX}-new`);
      const l1 = el('div', `${PREFIX}-l1`);
      l1.append(el('span', `${PREFIX}-code`, c.code), document.createTextNode(c.callType || ''));
      box.append(l1);
      box.append(el('div', `${PREFIX}-addr`, c.address || '(address not found)'));
      box.append(el('div', `${PREFIX}-units`, 'Units: ' + (c.units.length ? c.units.join(', ') : 'none assigned yet')));
      return box;
    }));
  }

  // ---------- main loop ----------
  let firstScan = true;
  function check() {
    const now = Date.now();
    const found = scan();

    for (const key of [...state.keys()]) {
      if (!found.has(key) && !key.startsWith('test:')) state.delete(key); // call cleared from Adashi
    }

    const seen = loadSeen();
    const brandNew = [];
    for (const [key, call] of found) {
      const s = state.get(key);
      if (s) { s.call = { ...call, address: call.address || s.call.address }; continue; }
      const isNew = !seen[key] && (!firstScan || CONFIG.SOUND_FOR_CALLS_AT_LOAD);
      state.set(key, {
        call, firstSeen: now, acked: !isNew,
        newUntil: isNew ? now + CONFIG.BANNER_SECONDS * 1000 : 0,
        repeatsLeft: isNew ? CONFIG.REPEAT_TIMES : 0,
        nextRepeat: now + CONFIG.REPEAT_EVERY_SECONDS * 1000,
      });
      if (isNew) brandNew.push(call);
    }
    const unseen = [...found.keys()].filter((k) => !seen[k]);
    if (unseen.length) markSeen(unseen);
    firstScan = false;

    if (brandNew.length) {
      log('NEW', brandNew);
      announce(brandNew);
    } else {
      const due = [...state.values()].filter((s) => !s.acked && s.newUntil > now && s.repeatsLeft > 0 && now >= s.nextRepeat);
      if (due.length) {
        due.forEach((s) => { s.repeatsLeft--; s.nextRepeat = now + CONFIG.REPEAT_EVERY_SECONDS * 1000; });
        announce(due.map((s) => s.call));
      }
    }
    render();
  }

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(check, 500); };

  setTimeout(() => {
    check();
    new MutationObserver((records) => {
      if (records.every((r) => isOurs(r.target.nodeType === 1 ? r.target : r.target.parentElement || document.body))) return;
      schedule();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(check, 2000); // also closes the banner on time & drives repeats
    if (CONFIG.SOUND || CONFIG.SPEAK) showUnlockButton();
  }, 3000);

  // ---------- Tampermonkey menu ----------
  GM_registerMenuCommand('Test: show a fake fire call', () => {
    const row = el('div');
    const key = 'test:' + Date.now();
    const call = { code: '69E01', callType: 'TEST - DWELLING FIRE', address: '123 N Main St', units: ['E5', 'T5'], text: '', row };
    state.set(key, { call, firstSeen: Date.now(), acked: false, newUntil: Date.now() + CONFIG.BANNER_SECONDS * 1000, repeatsLeft: 0, nextRepeat: Infinity });
    render();
    announce([call]);
    setTimeout(() => { state.delete(key); render(); }, CONFIG.BANNER_SECONDS * 1000 + 3000);
  });
  GM_registerMenuCommand('Sound on / off', () => {
    GM_setValue(ENABLED_KEY, !soundOn());
    if (!soundOn()) stopSound();
    alert('Fire call sound is now ' + (soundOn() ? 'ON' : 'OFF') + '. Calls still show on screen.');
  });
  GM_registerMenuCommand('Forget announced calls', () => {
    GM_setValue(STORE_KEY, '{}');
    alert('Cleared. Calls on screen now will not sound again; new ones will.');
    markSeen([...state.keys()]);
  });

  log('loaded');
})();
