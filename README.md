# Adashi Dwelling Fire Text Alert (Tampermonkey)

`adashi-dwelling-fire-alert.user.js` watches the live Adashi page and texts your phone
**once** when a new call appears with a code beginning in **69E** or **69D** (e.g. `69E01`,
`69-D-6`), **DW** (e.g. `DW`, `DWF`, `DWELL`) or **BOX** (e.g. `BOX`, `BOXALARM`).

## Setup

1. **Pick how alerts get to your phone** (set `PROVIDER` in the SETTINGS block):
   - `twilio`: a real SMS. Make a Twilio account, buy a number (about $1/month plus about $0.01 per text),
     and fill in `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` and `TO_NUMBERS`.
     US numbers need A2P 10DLC / toll-free verification before texts will deliver.
   - `ntfy`: free. Install the **ntfy** app on your phone, subscribe to a long random topic
     name, and put that same name in `NTFY_TOPIC`. This sends a push notification, not an SMS.
     Set the topic to "urgent" in the app so it can sound even when your phone is silenced.
   - `textbelt`: SMS with a paid key from textbelt.com. The key `textbelt` gives 1 free text per day for testing.
2. **Fix the `@match` lines** so they match your Adashi address. Open Adashi, copy the
   address bar (for example `https://cad.mycounty.gov/adashi/...`), and change the line to
   `// @match https://cad.mycounty.gov/*`.
3. In Firefox: Tampermonkey icon → *Create a new script* → delete the template → paste the file → **Save**.
4. Reload Adashi. Click the Tampermonkey icon → **Send test alert** to check delivery.
5. Use Tampermonkey icon → **Show matching calls on screen** to check that it sees your calls.

## What the alert looks like
```
FIRE CALL (69E01)
Address: 412 N Oak Ridge Rd
Units: E5, T5

2026-000102 69E01 DWELLING FIRE 412 N Oak Ridge Rd E5 T5 10:05
```
The last part is the full call row, in case the address or units weren't picked out right.
Units are often assigned after a call first appears. When new units are added, one
**UNITS UPDATE** follow-up is sent after the unit list stops changing for 20 seconds.
These follow-ups are sent for 15 minutes after the alert. Set `SEND_UNIT_UPDATES: false` to turn them off.

The address and units are found automatically: first from table column headers (like "Address"/"Location" and
"Units"), then from page elements named for them, then by pattern matching. If they come out wrong,
put CSS selectors in `ADDRESS_SELECTOR` / `UNITS_SELECTOR` (see the comments in the script).
The script can only read what is shown in the call list itself. It can't see units that appear
only in a separate details panel.

## Behavior
- Calls already on screen when the page loads do **not** text. Only calls that appear later do.
  (Set `ALERT_ON_CALLS_PRESENT_AT_LOAD: true` to change that.)
- Each call texts once. It is identified by its incident number, so later status, unit or
  timer changes do not send another text. Calls are remembered for 24 hours, including across page reloads and multiple tabs.
- `DWI` is ignored, and so are addresses like "69 E Main St" or "69 D St". Add more codes to ignore in `EXCLUDE_CODES`.
- The Adashi tab must stay open (it can be in the background). Keep the computer awake.
- Use the menu to **Pause / resume alerts** or **Forget alerted calls**.

## If something is off
- **Duplicate texts, or none at all:** right-click a call row in Adashi → *Inspect*. Find
  the element for one whole call (often a `<tr>`) and put a CSS selector for it in `ROW_SELECTOR`.
  If your incident numbers look different from `2026-001234`, adjust `INCIDENT_ID_PATTERN`.
- Set `DEBUG: true` and open the console (F12) to see what it is doing.
- Your Twilio token sits in plain text inside the script. Only use this on a computer you trust.

---

# Adashi Fire Call TV Display (Tampermonkey)

`adashi-fire-call-display.user.js` is for a laptop showing Adashi on a TV. When a call with a code
beginning in **69E**, **69D**, **DW** or **BOX** is on the Adashi page, it:

- shows a **large banner** across the top of the screen with the code, call type, **address** (largest text) and units;
- **highlights** that call's row in Adashi's own list (yellow with a red outline and bigger text);
- for a **new** call: flashes the banner, plays a **hi-lo alarm tone**, then **reads the call aloud**
  ("Fire call. 69 Echo 1. Dwelling fire. 412 North Oak Ridge Road."). The alarm repeats every 30 seconds
  (3 more times) until someone clicks **ACKNOWLEDGE**.

The banner updates as units are assigned, and a call drops off the banner when it leaves the Adashi list.
Calls already on screen when the page loads are shown right away but do not sound.
It runs alongside the text-alert script above. You can install both.

## Setup
1. Tampermonkey → *Create a new script* → paste `adashi-fire-call-display.user.js` → **Save**.
   The `@match` line is already set to the BCFD Adashi incidents page.
2. Reload Adashi. **Click once anywhere on the page** (or on the red *Click here to turn on fire call sound*
   button). Browsers block sound until someone clicks the page, so do this after every reload.
3. Tampermonkey icon → **Test: show a fake fire call** to check the banner and sound on the TV.
4. Casting: Chrome's *Cast tab* sends tab audio to the TV. *Cast screen/desktop* may keep the sound on the
   laptop. If you hear nothing on the TV, check the cast mode or plug in a speaker.
   Keep the laptop from sleeping, and don't mute the Adashi tab.

## Settings (top of the script)
- `TEXT_SIZE`: `1.5` makes everything 50% bigger on the TV. `ROW_TEXT_SCALE` sets the highlighted row's size.
- `BANNER_POSITION`: `'top'` or `'bottom'`. Click **Hide** to collapse the banner. It reopens on the next new call.
- `SOUND`, `SPEAK`, `VOLUME`, `TONE_SECONDS`, `REPEAT_EVERY_SECONDS`, `REPEAT_TIMES`.
- `PENDING_ONLY: true` shows only calls whose row also says "Pending" (change `PENDING_PATTERN` to match Adashi's wording).
- Menu → **Sound on / off** silences it while still showing calls.
- If the address, units or call type come out wrong, set `ADDRESS_SELECTOR`, `UNITS_SELECTOR`, `CALL_TYPE_SELECTOR`
  or `ROW_SELECTOR` as described in "If something is off" above.
