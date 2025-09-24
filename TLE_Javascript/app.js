/* =========================
   TLE Pass Generator – app.js (UTC + Bennett refraction + smooth progress + space-CSV)
   ========================= */

/* ---------- Constants / Globals ---------- */
const IDX_T = 0, IDX_AZ = 1, IDX_EL = 2;

function dayOfYearUTC(isoUtcOrDate) {
  const d = new Date(isoUtcOrDate);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const n = Math.floor((today - start) / 86400000) + 1; // 1..366
  return String(n).padStart(3, '0'); // "001".."366"
}


// Default time range (UTC) — current UTC → +4 days
const nowUTC = new Date();
const DEFAULT_START_UTC = new Date(Date.UTC(
  nowUTC.getUTCFullYear(),
  nowUTC.getUTCMonth(),
  nowUTC.getUTCDate(),
  nowUTC.getUTCHours(),
  nowUTC.getUTCMinutes(),
  nowUTC.getUTCSeconds()
));
const DEFAULT_END_UTC = new Date(+DEFAULT_START_UTC + 4 * 24 * 60 * 60 * 1000); // +4 days

// Built-in fallback TLE (works even if no file is loaded)
const DEFAULT_TLE_TEXT = `
EM1
1 44078U 19072A   25237.00127315  .00000014  00000-0  40313-4 0  1239
2 44078  98.2808 291.9629 0018719  34.1424  38.1671 14.43768520337337
`.trim();

let parsedTLEs = [];          // [{name,l1,l2}]
let resultsByTLE = [];        // per-TLE results (rows & groups)
let groupsFlat = [];          // flattened groups for the table & modal navigation

const modalState = { groupKey: null, page: 1, rpp: 20 };

/* ---------- DOM helpers ---------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const byId = (id) => document.getElementById(id);

function pad2(n) { return String(n).padStart(2, '0'); }
function toRad(d) { return d * Math.PI / 180; }
function toDeg(r) { return r * 180 / Math.PI; }
function isoUTC(d) { return new Date(d).toISOString().replace('.000', ''); }
function fixed(n, d = 2) { return (Number.isFinite(n) ? n : 0).toFixed(d); }

function sanitizeName(s) { return (s || 'tle').replace(/[^\w\-]+/g, '_').slice(0, 80); }
function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  URL.revokeObjectURL(url); a.remove();
}
function downloadText(name, text) {
  downloadBlob(name, new Blob([text], { type: 'text/plain' }));
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/* ---------- UTC datetime-local filler ---------- */
// Force inputs to display **UTC** values (not local)
function setDateTimeUTC(id, date) {
  const el = byId(id); if (!el) return;
  const dt = new Date(date);
  const y = dt.getUTCFullYear(), m = pad2(dt.getUTCMonth() + 1), d = pad2(dt.getUTCDate());
  const H = pad2(dt.getUTCHours()), M = pad2(dt.getUTCMinutes()), S = pad2(dt.getUTCSeconds());
  el.value = `${y}-${m}-${d}T${H}:${M}:${S}`;
}

function getDecimalCount(){
    if (byId('decimals').value != undefined) return parseInt(byId('decimals').value, 10);
    return 2;
}

function ensureDefaultTimeRange() {
  if (!byId('startTime').value) setDateTimeUTC('startTime', DEFAULT_START_UTC);
  if (!byId('endTime').value) setDateTimeUTC('endTime', DEFAULT_END_UTC);
}

/* ---------- Atmosphere helpers (barometric pressure + Bennett refraction) ---------- */
// Approx barometric formula (sea-level p0=1013.25 mbar), altitude in **meters**
function pressure_mbar_from_alt_m(alt_m, p0mbar = 1013.25) {
  const T0 = 288.15, L = 0.0065, g = 9.80665, M = 0.0289644, R = 8.3144598;
  // Tropospheric (to ~11km): p = p0 * (1 - L*h/T0)^(g*M/(R*L))
  const h = Math.max(0, alt_m);
  return p0mbar * Math.pow(1.0 - (L * h) / T0, (g * M) / (R * L));
}

// Bennett/Saemundsson refraction in **degrees**; returns corrected elevation (deg)
function refract_bennett_deg(altDeg, tempC, pressureMbar) {
  if (altDeg <= -1.0) return altDeg; // below horizon, skip
  const altRad = toRad(altDeg);
  const R_arcmin = (pressureMbar / 1010.0) * (283.0 / (273.0 + tempC))
    * (1.02 / Math.tan(altRad + (10.3 * Math.PI / 180.0) / (altDeg + 5.11)));
  return altDeg + (R_arcmin / 60.0);
}

/* ---------- Tilt correction ---------- */
function applyTilt(azDeg, elDeg, tiltDeg, tiltAzDeg) {
  if (!tiltDeg || Math.abs(tiltDeg) < 1e-9) return { az: azDeg, el: elDeg };
  const az = toRad(azDeg), el = toRad(elDeg);
  const t = toRad(tiltDeg), tz = toRad(tiltAzDeg || 0);

  const E = Math.cos(el) * Math.sin(az);
  const N = Math.cos(el) * Math.cos(az);
  const U = Math.sin(el);
  const v = [E, N, U];

  // axis in horizontal plane perpendicular to desired downwards tilt dir
  const k = [-Math.cos(tz), Math.sin(tz), 0];
  const ct = Math.cos(-t), st = Math.sin(-t);
  const cross = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  const v2 = [
    v[0] * ct + cross[0] * st + k[0] * dot * (1 - ct),
    v[1] * ct + cross[1] * st + k[1] * dot * (1 - ct),
    v[2] * ct + cross[2] * st + k[2] * dot * (1 - ct)
  ];
  const el2 = toDeg(Math.asin(Math.max(-1, Math.min(1, v2[2]))));
  const az2 = (toDeg(Math.atan2(v2[0], v2[1])) + 360) % 360;
  return { az: az2, el: el2 };
}

/* ---------- TLE parsing & fallback ---------- */
function parseTLEText(text) {
  const lines = (text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length;) {
    if (/^1\s*\d{5}/.test(lines[i]) && i + 1 < lines.length && /^2\s*\d{5}/.test(lines[i + 1])) {
      out.push({ name: `TLE_${out.length + 1}`, l1: lines[i], l2: lines[i + 1] }); i += 2;
    } else if (i + 2 < lines.length && /^1\s*\d{5}/.test(lines[i + 1]) && /^2\s*\d{5}/.test(lines[i + 2])) {
      out.push({ name: lines[i] || `TLE_${out.length + 1}`, l1: lines[i + 1], l2: lines[i + 2] }); i += 3;
    } else { i += 1; }
  }
  return out;
}
function loadDefaultTLEIfEmpty() {
  if (parsedTLEs.length) return;
  parsedTLEs = parseTLEText(DEFAULT_TLE_TEXT);
  fillFilePickers();
  fillTlePickerToFields();
}

/* ---------- Space-CSV helpers (HH MM SS.zzz  Az EL) ---------- */
function fmtHMSmsFromISO(isoUtc) {
  const d = new Date(isoUtc);
  const HH = pad2(d.getUTCHours());
  const MM = pad2(d.getUTCMinutes());
  const SS = pad2(d.getUTCSeconds());
  const zzz = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${HH} ${MM} ${SS}.${zzz}`;
}
function fmtFixedSigned(value, intDigits, fracDigits) {
  if (!Number.isFinite(value)) return ''; // blank for NaN
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const i = Math.floor(abs).toString().padStart(intDigits, '0');
  const f = abs.toFixed(fracDigits).split('.')[1];
  return `${sign}${i}.${f}`;
}
function fmtAz(az) { return fmtFixedSigned(az, 3, getDecimalCount()); } // XXX.XX
function fmtEl(el) { return fmtFixedSigned(el, 2, getDecimalCount()); } // XX.XX
function buildHMSCsvLines(rows) {
  const lines = ['HH MM SS.zzz  Az EL'];
  for (const r of rows) {
    const t = fmtHMSmsFromISO(r[0]);
    const a = fmtAz(r[1]);
    const e = fmtEl(r[2]);
    lines.push(`${t} ${a} ${e}`);
  }
  return lines;
}

/* ---------- Compute track (UTC, Bennett refraction) with per-step progress ---------- */
function computeTrackForTLE(
  satrec, startDate, endDate, stepMs, obs, doRefract, tempC,
  onStepProgress /* optional: (fraction 0..1) => void */
) {
  const rows = [];
  const start = +startDate, end = +endDate, step = Math.max(100, stepMs | 0);
  const totalSteps = Math.max(1, Math.floor((end - start) / step) + 1);
  let stepIdx = 0;

  // Pressure from **meters** altitude
  const Pmbar = pressure_mbar_from_alt_m(obs.alt_m);

  for (let t = start; t <= end; t += step) {
    const dt = new Date(t);                  // UTC based
    const gmst = satellite.gstime(dt);       // satellite.js v6
    const pv = satellite.propagate(satrec, dt);
    if (!pv.position) {
      rows.push([isoUTC(dt), NaN, NaN]);
      stepIdx++; if (onStepProgress) onStepProgress(stepIdx / totalSteps);
      continue;
    }

    const posEcf = satellite.eciToEcf(pv.position, gmst);
    const observerGd = {
      longitude: toRad(obs.lon),
      latitude: toRad(obs.lat),
      height: obs.alt_m / 1000.0  // km
    };
    const look = satellite.ecfToLookAngles(observerGd, posEcf);

    // Angles in degrees, az normalized to [0,360)
    let az = (toDeg(look.azimuth) + 360) % 360;
    let el = toDeg(look.elevation);

    // Optional tilt
    if (obs.tiltDeg) {
      const c = applyTilt(az, el, obs.tiltDeg, obs.tiltAzDeg || 0);
      az = c.az; el = c.el;
    }

    // Optional Bennett refraction
    if (doRefract) {
      el = refract_bennett_deg(el, tempC, Pmbar);
    }

    rows.push([isoUTC(dt), Number(az.toFixed(2)), Number(el.toFixed(2))]);

    // per-step progress
    stepIdx++;
    if (onStepProgress) onStepProgress(stepIdx / totalSteps);
  }
  return rows;
}

/* ---------- Grouping & stats ---------- */
function groupRows(rows, minEl) {
  // Group where Az>0 and El>minEl
  const groups = [];
  let cur = [];
  for (const r of rows) {
    const az = r[IDX_AZ], el = r[IDX_EL];
    if (az > 0 && el > minEl) cur.push(r);
    else { if (cur.length) { groups.push(cur); cur = []; } }
  }
  if (cur.length) groups.push(cur);

  const stats = groups.map(g => {
    let minEl = 90, maxEl = -90;
    let startAz = g[0][IDX_AZ], endAz = g[g.length - 1][IDX_AZ];
    for (const r of g) { if (r[IDX_EL] < minEl) minEl = r[IDX_EL]; if (r[IDX_EL] > maxEl) maxEl = r[IDX_EL]; }
    return {
      start: g[0][IDX_T],
      end: g[g.length - 1][IDX_T],
      minEl: Number(minEl.toFixed(2)),
      maxEl: Number(maxEl.toFixed(2)),
      startAz: Number(startAz.toFixed(2)),
      endAz: Number(endAz.toFixed(2)),
      samples: g.length
    };
  });
  return { groups, stats };
}

/* ---------- UI: progress ---------- */
function setBusy(b) {
  const pb = byId('progressBar'), wrap = byId('progressWrap');
  byId('generateBtn').disabled = b;
  if (wrap) wrap.classList.toggle('hidden', !b);
  if (pb) { pb.style.width = b ? '30%' : '0%'; pb.setAttribute('aria-valuenow', b ? '30' : '0'); }
}
function setProgress(pct) {
  const pb = byId('progressBar');
  if (!pb) return;
  const c = Math.max(0, Math.min(100, pct | 0));
  pb.style.width = `${c}%`; pb.setAttribute('aria-valuenow', `${c}`);
}

/* ---------- UI: file pickers ---------- */
function fillFilePickers() {
  const selA = byId('whichTleFromFile');
  const selB = byId('tlePicker');
  [selA, selB].forEach(sel => {
    if (!sel) return;
    sel.innerHTML = '';
    parsedTLEs.forEach((t, i) => {
      const o = document.createElement('option');
      o.value = String(i); o.textContent = t.name; sel.appendChild(o);
    });
    sel.classList.toggle('hidden', parsedTLEs.length === 0);
  });
}
function fillTlePickerToFields() {
  const sel = byId('tlePicker');
  if (!sel) return;
  sel.onchange = () => {
    const idx = parseInt(sel.value, 10);
    const t = parsedTLEs[idx];
    if (t) {
      byId('tleName').value = t.name;
      byId('tleL1').value = t.l1;
      byId('tleL2').value = t.l2;
    }
  };
}
function renderGroupsTable() {
  const tbody = $('#groupTable tbody');
  const table = byId('groupTable');
  const lbl = byId('groupCountLabel');
  const noMsg = byId('noGroupsMsg');

  tbody.innerHTML = '';
  groupsFlat = []; // reset

  // flatten all groups
  resultsByTLE.forEach((tleRes, tleIdx) => {
    tleRes.groups.forEach((g, gi) => {
      const s = tleRes.stats[gi];
      groupsFlat.push({
        tleIdx,
        gi,
        tleName: tleRes.name,
        start: s.start,
        end: s.end,
        minEl: s.minEl,
        maxEl: s.maxEl,
        startAz: s.startAz,
        endAz: s.endAz,
        samples: s.samples,
      });
    });
  });

  // sort by start time
  groupsFlat.sort((a, b) => new Date(a.start) - new Date(b.start));

  // render
  let counter = 0;
  groupsFlat.forEach(item => {
    const tr = document.createElement('tr');

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open';
    const groupKey = `${item.tleIdx}:${item.gi}`;
    openBtn.addEventListener('click', () => openGroupModal(groupKey));

    const cells = [
      ++counter,
      item.tleName,
      item.start,
      item.end,
      fixed(item.minEl, getDecimalCount()),
      fixed(item.maxEl, getDecimalCount()),
      fixed(item.startAz, getDecimalCount()),
      fixed(item.endAz, getDecimalCount()),
      item.samples
    ];
    cells.forEach(val => {
      const td = document.createElement('td');
      td.textContent = val;
      tr.appendChild(td);
    });

    const tdAct = document.createElement('td');
    tdAct.appendChild(openBtn);
    tr.appendChild(tdAct);

    tbody.appendChild(tr);
  });

  const totalGroups = groupsFlat.length;
  table.classList.toggle('hidden', totalGroups === 0);
  noMsg.classList.toggle('hidden', totalGroups !== 0);
  lbl.textContent = `${totalGroups} group(s)`;

  byId('downloadGroupsZipBtn').disabled = totalGroups === 0;
  byId('downloadAllBtn').disabled = !resultsByTLE.some(r => r.allRows.length);
}

/* ---------- Modal ---------- */
function closeModal() { byId('groupModal').classList.add('hidden'); $('.modal-backdrop').setAttribute('aria-hidden', 'true'); }
function openModal() { byId('groupModal').classList.remove('hidden'); $('.modal-backdrop').setAttribute('aria-hidden', 'false'); }

function openGroupModal(groupKey) {
  modalState.groupKey = groupKey;
  modalState.page = 1;
  renderGroupModalPage();
  openModal();
}

function renderGroupModalPage() {
  if (!modalState.groupKey) return;
  const [tleIdxStr, giStr] = modalState.groupKey.split(':');
  const tleIdx = parseInt(tleIdxStr, 10), gi = parseInt(giStr, 10);
  const r = resultsByTLE[tleIdx];
  const g = r?.groups?.[gi] || [];
  const title = byId('groupTitle');
  title.textContent = `${r?.name || 'TLE'} — Group ${gi + 1} (${g.length} rows)`;

  const rppSel = byId('modalRowsPerPage');
  const rpp = parseInt(rppSel?.value || modalState.rpp, 10) || 20;
  modalState.rpp = rpp;

  const totalPages = Math.max(1, Math.ceil(g.length / rpp));
  modalState.page = Math.max(1, Math.min(modalState.page, totalPages));

  const start = (modalState.page - 1) * rpp;
  const pageRows = g.slice(start, start + rpp);

  const tbody = $('#groupDetailsTable tbody');
  tbody.innerHTML = '';
  pageRows.forEach(row => {
    const tr = document.createElement('tr');
    [row[IDX_T], fixed(row[IDX_AZ], getDecimalCount()), fixed(row[IDX_EL], getDecimalCount())].forEach(v => {
      const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });

  byId('modalPageInfo').textContent = `Page ${modalState.page}/${totalPages} • ${g.length} rows`;
  byId('modalPrevBtn').disabled = modalState.page <= 1;
  byId('modalNextBtn').disabled = modalState.page >= totalPages;

  // Download current group CSV (space format)
  byId('downloadGroupCsv').onclick = () => {
    const name = `${sanitizeName(r?.name || 'TLE')}__group_${String(gi + 1).padStart(2, '0')}.csv`;
    const lines = buildHMSCsvLines(g);
    downloadText(name, lines.join('\n'));
  };
}

/* ---------- Generate (UTC) ---------- */
async function generate() {
  ensureDefaultTimeRange();

  const lat = parseFloat(byId('obsLat').value || '0') || 0;
  const lon = parseFloat(byId('obsLon').value || '0') || 0;
  const alt_m = (parseFloat(byId('obsAltM').value || '0') || 0); // meters

  const tiltDeg = parseFloat(byId('tiltDeg').value || '0') || 0;
  const tiltAzDeg = parseFloat(byId('tiltAzDeg').value || '0') || 0;

  const startStr = byId('startTime').value; // "YYYY-MM-DDTHH:mm:ss"
  const endStr = byId('endTime').value;     // "YYYY-MM-DDTHH:mm:ss"
  const stepMs = parseInt(byId('resolutionMs').value || '1000', 10) || 1000;

  const doRefract = byId('applyRefraction').checked;
  const tempC = parseFloat(byId('tempC').value || '15') || 15;

  const mode = byId('whichTles').value || 'current';

  // Build TLE list based on mode
  let tleList = [];
  if (mode === 'current') {
    const name = byId('tleName').value.trim();
    const l1 = byId('tleL1').value.trim();
    const l2 = byId('tleL2').value.trim();
    if (name && l1 && l2) tleList.push({ name, l1, l2 });
  } else if (mode === 'specific') {
    if (parsedTLEs.length) {
      const idx = parseInt(byId('whichTleFromFile').value || '0', 10) || 0;
      if (parsedTLEs[idx]) tleList.push(parsedTLEs[idx]);
    }
  } else { // all
    tleList = parsedTLEs.slice();
  }

  // Fallback if empty
  if (!tleList.length) {
    loadDefaultTLEIfEmpty();
    tleList = parsedTLEs.slice(0, 1);
  }

  // Time range — interpret inputs as **UTC** (append "Z")
  let startDate, endDate;
  if (startStr && endStr) {
    startDate = new Date(startStr + "Z");
    endDate   = new Date(endStr + "Z");
    if (!isFinite(+startDate) || !isFinite(+endDate)) {
      alert('Invalid time range. Please enter valid UTC datetimes.');
      return;
    }
    // Rule 1: start <= end
    if (+endDate < +startDate) {
      alert('Start time must be less than or equal to End time.');
      return;
    }
    // Rule 2: maximum span is 7 days
    const MAX_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
    if ((+endDate - +startDate) > MAX_SPAN_MS) {
      alert('Maximum allowed range is 7 days. Please shorten the interval.');
      return;
    }
  } else {
    startDate = new Date(DEFAULT_START_UTC);
    endDate   = new Date(DEFAULT_END_UTC);
  }

  // Compute
  resultsByTLE = [];
  setBusy(true); setProgress(5);
  const status = byId('statusText');
  try {
    const minEl = parseFloat(byId('minElFilter')?.value || '0') || 0;
    for (let i = 0; i < tleList.length; i++) {
      const tle = tleList[i];
      const satrec = satellite.twoline2satrec(tle.l1, tle.l2);
      const obs = { lat, lon, alt_m, tiltDeg, tiltAzDeg };

      // Allocate 80% band among TLEs, then interpolate within each TLE
      const baseStart = 5 + Math.round((i / tleList.length) * 80);
      const baseEnd   = 5 + Math.round(((i + 1) / tleList.length) * 80);

      const rows = computeTrackForTLE(
        satrec, startDate, endDate, stepMs, obs, doRefract, tempC,
        (f) => {
          const pct = Math.round(baseStart + (baseEnd - baseStart) * Math.min(Math.max(f, 0), 1));
          setProgress(pct);
          if (status) status.textContent = `Processing ${tle.name} (${i + 1}/${tleList.length}) — ${pct}%`;
        }
      );

      const { groups, stats } = groupRows(rows, minEl);
      resultsByTLE.push({ name: tle.name, allRows: rows, groups, stats });
    }

    renderGroupsTable();
    setProgress(100);
    if (status) status.textContent = 'Done — 100%';
  } catch (e) {
    console.error(e);
    alert('Generation failed. See console for details.');
  } finally {
    setTimeout(() => { setBusy(false); setProgress(0); if (status) status.textContent = ''; }, 600);
  }
}

/* ---------- File handling ---------- */
async function handleTleFile(file) {
  if (!file) { loadDefaultTLEIfEmpty(); return; }
  try {
    const text = await file.text();
    parsedTLEs = parseTLEText(text);
    if (!parsedTLEs.length) { loadDefaultTLEIfEmpty(); }
    fillFilePickers();
    fillTlePickerToFields();
  } catch (e) {
    console.warn('TLE read failed, using fallback', e);
    parsedTLEs = []; loadDefaultTLEIfEmpty();
  }
}

/* ---------- Downloads (All/Groups ZIP) ---------- */
function setupDownloads() {
  // All-in-one file (space-CSV)
  byId('downloadAllBtn').addEventListener('click', () => {
    const any = resultsByTLE.some(r => r.allRows.length);
    if (!any) return;

    const header = 'HH MM SS.zzz  Az EL';
    const lines = [header];

    resultsByTLE.forEach(r => {
      r.allRows.forEach(a => {
        const t = fmtHMSmsFromISO(a[0]);
        const az = fmtAz(a[1]);
        const el = fmtEl(a[2]);
        lines.push(`${t} ${az} ${el}`);
      });
    });

    downloadText('all_results_combined.csv', lines.join('\n'));
  });

  // Per-group files in a ZIP (space-CSV)
  byId('downloadGroupsZipBtn').addEventListener('click', async () => {
    const has = resultsByTLE.some(r => r.groups.length);
    if (!has) return;
    const zip = new JSZip();
    resultsByTLE.forEach(r => {
      r.groups.forEach((g, gi) => {
        const firstIso = g[0][IDX_T];     // group's first angle timestamp (ISO UTC)
        const doy = dayOfYearUTC(firstIso);
        const name = `pts${String(gi).padStart(5, '0')}_${sanitizeName(r.name)}_${byId('antennaId').value}.${doy}`;
        const fileText = buildHMSCsvLines(g).join('\n');
        zip.file(name, fileText);
      });
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob('groups.zip', blob);
  });
}

/* ---------- Wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  // Default times & demo TLE (so it works without a file)
  ensureDefaultTimeRange();
  loadDefaultTLEIfEmpty();

  // Generate
  byId('generateBtn').addEventListener('click', generate);

  // File load
  const file = byId('tleFile');
  byId('loadTleBtn').addEventListener('click', () => handleTleFile(file.files?.[0]));
  file.addEventListener('change', () => handleTleFile(file.files?.[0]));

  // Pickers
  fillFilePickers();
  fillTlePickerToFields();

  // Modal controls
  byId('closeModal').addEventListener('click', closeModal);
  $('.modal-backdrop').addEventListener('click', closeModal);
  byId('modalPrevBtn').addEventListener('click', () => { modalState.page--; renderGroupModalPage(); });
  byId('modalNextBtn').addEventListener('click', () => { modalState.page++; renderGroupModalPage(); });
  byId('modalFirstBtn').addEventListener('click', () => { modalState.page = 1; renderGroupModalPage(); });
  byId('modalLastBtn').addEventListener('click', () => {
    const [tleIdxStr, giStr] = modalState.groupKey.split(':');
    const tleIdx = parseInt(tleIdxStr, 10), gi = parseInt(giStr, 10);
    const g = resultsByTLE[tleIdx]?.groups?.[gi] || [];
    const totalPages = Math.max(1, Math.ceil(g.length / modalState.rpp));
    modalState.page = totalPages;
    renderGroupModalPage();
  });
  byId('modalRowsPerPage').addEventListener('change', () => { modalState.page = 1; renderGroupModalPage(); });

  // Downloads
  setupDownloads();
});
