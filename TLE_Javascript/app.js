/* ======= Constants / Globals ======= */
const TIMESTAMP_INDEX = 0;
const AZIMUTH_INDEX   = 1;
const ELEVATION_INDEX = 2;

let allResults = [];          // Array<[timeISO, azDegStr, elDegStr>]
let groupedPasses = [];       // Array<Array<[timeISO, azStr, elStr]>>
let groupedSummary = [];      // Array<summary objects>

const modalState = {
  groupIndex: -1,
  page: 1,
  rowsPerPage: 20
};

/* ======= Helpers: DOM ======= */
const $ = (sel) => document.querySelector(sel);

function setProgress(p) {
  const wrap = $('#progressWrap');
  const bar = $('#progressBar');
  wrap.classList.remove('hidden');
  wrap.setAttribute('aria-hidden', 'false');
  bar.style.width = `${Math.max(0, Math.min(100, p))}%`;
  if (p >= 100) {
    setTimeout(() => {
      wrap.classList.add('hidden');
      wrap.setAttribute('aria-hidden', 'true');
      bar.style.width = '0%';
    }, 400);
  }
}

function fmtISO(d) {
  const z = (n, w=2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth()+1)}-${z(d.getUTCDate())} `
       + `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}.${z(d.getUTCMilliseconds(),3)}`;
}
const toRadians = (d) => d * Math.PI / 180;
const toDegrees = (r) => r * 180 / Math.PI;

/* ======= Ensure libraries (fallback ESM) ======= */
async function ensureSatelliteLoaded() {
  if (typeof window.satellite === 'undefined') {
    const mod = await import('https://cdn.jsdelivr.net/npm/satellite.js@6.0.1/+esm');
    window.satellite = mod;
  }
}
async function ensureJSZipLoaded() {
  if (typeof window.JSZip === 'undefined') {
    const mod = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
    window.JSZip = mod.default || mod;
  }
}

/* ======= Refraction & Pressure ======= */
function pressureMbarFromAltMeters(h_m) {
  return 1013.25 * Math.pow(1 - 2.25577e-5 * h_m, 5.25588);
}
function refractElevationDeg(elDeg, pressure_mbar, temp_c) {
  if (elDeg <= -1) return elDeg;
  const T_k = 273.15 + temp_c;
  const R_arcmin = 1.02 / Math.tan(toRadians(elDeg + 10.3 / (elDeg + 5.11)));
  const scale = (pressure_mbar / 1010.0) * (283.0 / T_k);
  return elDeg + (R_arcmin * scale) / 60.0;
}

/* ======= Tilt correction ======= */
function applyTilt(azDeg, elDeg, tiltDeg, tiltAzDeg) {
  if (!tiltDeg) return [azDeg, elDeg];

  const az = toRadians(azDeg);
  const el = toRadians(elDeg);
  const t  = toRadians(tiltDeg);
  const tz = toRadians(tiltAzDeg);

  const E = Math.cos(el) * Math.sin(az);
  const N = Math.cos(el) * Math.cos(az);
  const U = Math.sin(el);
  const v = [E, N, U];

  // Axis k = u × d, with u=[0,0,1], d=[sin tz, cos tz, 0] => k=[-cos tz, sin tz, 0]
  const k = [-Math.cos(tz), Math.sin(tz), 0];

  const ct = Math.cos(-t), st = Math.sin(-t);
  const kx = k[0], ky = k[1], kz = k[2];
  const cross = [
    ky * v[2] - kz * v[1],
    kz * v[0] - kx * v[2],
    kx * v[1] - ky * v[0]
  ];
  const dot = kx * v[0] + ky * v[1] + kz * v[2];
  const vPrime = [
    v[0] * ct + cross[0] * st + kx * dot * (1 - ct),
    v[1] * ct + cross[1] * st + ky * dot * (1 - ct),
    v[2] * ct + cross[2] * st + kz * dot * (1 - ct)
  ];

  const E2 = vPrime[0], N2 = vPrime[1], U2 = vPrime[2];
  let az2 = toDegrees(Math.atan2(E2, N2));
  if (az2 < 0) az2 += 360;
  const el2 = toDegrees(Math.asin(Math.max(-1, Math.min(1, U2))));
  return [az2, el2];
}

/* ======= CSV / ZIP helpers ======= */
function toCsv(headers, rows) {
  const esc = (s) => {
    const t = String(s ?? '');
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const head = headers.map(esc).join(',');
  const body = rows.map(r => r.map(esc).join(',')).join('\n');
  return head + '\n' + body;
}
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  a.remove();
}
function downloadCsv(filename, headers, rows) {
  const csv = toCsv(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(filename, blob);
}

/* ======= Grouping ======= */
function groupPositiveAzEl(rows) {
  const groups = [];
  let cur = [];
  for (const r of rows) {
    const az = parseFloat(r[AZIMUTH_INDEX]);
    const el = parseFloat(r[ELEVATION_INDEX]);
    if (az > 0 && el > 0) {
      cur.push(r);
    } else if (cur.length) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function summarizeGroups(groups) {
  return groups.map((g, idx) => {
    const start = g[0];
    const end   = g[g.length - 1];

    let minEl = +g[0][ELEVATION_INDEX];
    let maxEl = +g[0][ELEVATION_INDEX];
    for (const row of g) {
      const el = +row[ELEVATION_INDEX];
      if (el < minEl) minEl = el;
      if (el > maxEl) maxEl = el;
    }

    const d = decimals();
    return {
      idx,
      startTime: start[TIMESTAMP_INDEX],
      endTime: end[TIMESTAMP_INDEX],
      minEl: minEl.toFixed(d),
      maxEl: maxEl.toFixed(d),
      startAz: (+start[AZIMUTH_INDEX]).toFixed(d),
      endAz: (+end[AZIMUTH_INDEX]).toFixed(d),
      count: g.length
    };
  });
}

function renderGroupSummary(summary) {
  const table = $('#groupTable');
  const tbody = table.querySelector('tbody');
  const emptyMsg = $('#noGroupsMsg');
  const countLabel = $('#groupCountLabel');
  tbody.innerHTML = '';

  summary.forEach((s, i) => {
    const tr = document.createElement('tr');
    const c = (text) => { const td = document.createElement('td'); td.textContent = text; return td; };
    tr.appendChild(c(i + 1));
    tr.appendChild(c(s.startTime));
    tr.appendChild(c(s.endTime));
    tr.appendChild(c(s.minEl));
    tr.appendChild(c(s.maxEl));
    tr.appendChild(c(s.startAz));
    tr.appendChild(c(s.endAz));
    tr.appendChild(c(s.count));

    const actionTd = document.createElement('td');
    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => showGroupDetails(s.idx));
    actionTd.appendChild(viewBtn);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  });

  const has = summary.length > 0;
  table.classList.toggle('hidden', !has);
  emptyMsg.classList.toggle('hidden', has);
  countLabel.textContent = has ? `${summary.length} group(s)` : '';
  $('#downloadGroupsZipBtn').disabled = !has;
}

/* ======= Modal (pagination inside modal) ======= */
function renderGroupModalPage() {
  const g = groupedPasses[modalState.groupIndex] || [];
  const total = g.length;
  const pages = Math.max(1, Math.ceil(total / modalState.rowsPerPage));
  modalState.page = Math.max(1, Math.min(modalState.page, pages));

  const startIdx = (modalState.page - 1) * modalState.rowsPerPage;
  const endIdx = Math.min(total, startIdx + modalState.rowsPerPage);
  const slice = g.slice(startIdx, endIdx);

  const tbody = $('#groupDetailsTable tbody');
  tbody.innerHTML = '';
  for (const r of slice) {
    const tr = document.createElement('tr');
    const tdT = document.createElement('td'); tdT.textContent = r[TIMESTAMP_INDEX];
    const tdA = document.createElement('td'); tdA.textContent = r[AZIMUTH_INDEX];
    const tdE = document.createElement('td'); tdE.textContent = r[ELEVATION_INDEX];
    tr.appendChild(tdT); tr.appendChild(tdA); tr.appendChild(tdE);
    tbody.appendChild(tr);
  }

  $('#modalPageInfo').textContent = `Page ${modalState.page}/${pages} • ${total} rows`;
  $('#modalPrevBtn').disabled = modalState.page <= 1;
  $('#modalNextBtn').disabled = modalState.page >= pages;
}

function showGroupDetails(groupIndex) {
  modalState.groupIndex = groupIndex;
  modalState.page = 1;

  const g = groupedPasses[groupIndex] || [];
  $('#groupTitle').textContent = `Group #${groupIndex + 1} — ${g.length} samples`;

  renderGroupModalPage();

  // CSV for entire group
  $('#downloadGroupCsv').onclick = () => {
    downloadCsv(`group_${String(groupIndex + 1).padStart(2,'0')}.csv`,
      ['time_utc','az_deg','el_deg'],
      g
    );
  };

  const modal = $('#groupModal');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

(function wireModalControls(){
  // Rows per page selector
  $('#modalRowsPerPage').addEventListener('change', (e) => {
    modalState.rowsPerPage = parseInt(e.target.value, 10) || 20;
    renderGroupModalPage();
  });
  // Prev/Next
  $('#modalPrevBtn').addEventListener('click', () => {
    modalState.page -= 1;
    renderGroupModalPage();
  });
  $('#modalNextBtn').addEventListener('click', () => {
    modalState.page += 1;
    renderGroupModalPage();
  });

  // Close only on close button or backdrop
  const modal = $('#groupModal');
  const closeBtn = $('#closeModal');
  const backdrop = modal ? modal.querySelector('.modal-backdrop') : null;
  const content = modal ? modal.querySelector('.modal-content') : null;

  const close = () => {
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  };

  if (closeBtn) closeBtn.addEventListener('click', close);
  if (backdrop) backdrop.addEventListener('click', close);

  // Ensure clicks inside modal do NOT close (extra safety)
  if (content) content.addEventListener('click', (e) => e.stopPropagation());
})();

/* ======= UI getters ======= */
function decimals() { return Math.max(0, Math.min(6, parseInt($('#decimals').value || '0', 10))); }

/* ======= Resolution (ms, forced to multiples of 100 ms) ======= */
function readStepMs() {
  let v = parseInt($('#resolutionMs')?.value || '100', 10);
  if (isNaN(v)) v = 100;
  v = Math.max(100, Math.round(v / 100) * 100); // multiple of 100ms
  if ($('#resolutionMs')) $('#resolutionMs').value = v; // normalize UI display
  return v;
}

/* ======= ZIP: all groups ======= */
async function downloadGroupsZip() {
  if (!groupedPasses.length) return;
  await ensureJSZipLoaded();
  const zip = new JSZip();

  // 1) One CSV per group
  const headers = ['time_utc','az_deg','el_deg'];
  groupedPasses.forEach((g, i) => {
    const csv = toCsv(headers, g);
    zip.file(`group_${String(i+1).padStart(2,'0')}.csv`, csv);
  });

  // 2) Add a summary CSV
  const summaryHeaders = ['group_index','start_utc','end_utc','min_el_deg','max_el_deg','start_az_deg','end_az_deg','samples'];
  const summaryRows = groupedSummary.map(s => [
    s.idx + 1, s.startTime, s.endTime, s.minEl, s.maxEl, s.startAz, s.endAz, s.count
  ]);
  zip.file('groups_summary.csv', toCsv(summaryHeaders, summaryRows));

  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob('groups.zip', blob);
}

/* ======= Main compute ======= */
async function generate() {
  await ensureSatelliteLoaded();

  const l1 = $('#tleL1').value.trim();
  const l2 = $('#tleL2').value.trim();

  const latDeg = parseFloat($('#obsLat').value);
  const lonDeg = parseFloat($('#obsLon').value);
  const altM   = parseFloat($('#obsAltM').value);
  const altKm  = altM / 1000.0;

  const startLocal = $('#startTime').value;
  const endLocal   = $('#endTime').value;
  if (!startLocal || !endLocal) {
    alert('Please set start and end times.');
    return;
  }
  const start = new Date(startLocal);
  const end   = new Date(endLocal);
  if (isNaN(start) || isNaN(end) || end <= start) {
    alert('Invalid time range.');
    return;
  }

  // Sampling in milliseconds (multiples of 100 ms)
  const stepMs = readStepMs();
  const nSteps = Math.floor((end - start) / stepMs) + 1;

  const applyRef = $('#applyRefraction').checked;
  const tempC    = parseFloat($('#tempC').value);
  const pressure = pressureMbarFromAltMeters(altM);

  const tiltDeg  = parseFloat($('#tiltDeg').value) || 0;
  const tiltAz   = parseFloat($('#tiltAzDeg').value) || 0;

  // Prepare propagator
  const satrec = satellite.twoline2satrec(l1, l2);
  const observerGd = {
    longitude: toRadians(lonDeg),
    latitude: toRadians(latDeg),
    height: altKm
  };

  allResults = [];
  setProgress(0);

  // Update progress roughly every ~2 seconds worth of samples
  const chunk = Math.max(100, Math.floor(20000 / stepMs));
  for (let i = 0; i < nSteps; i += 1) {
    const t = new Date(start.getTime() + i * stepMs);

    const pv = satellite.propagate(satrec, t);
    if (!pv.position) continue;

    const gmst = satellite.gstime(t);
    const positionEcf = satellite.eciToEcf(pv.position, gmst);

    const look = satellite.ecfToLookAngles(observerGd, positionEcf);
    let azDeg = (toDegrees(look.azimuth) + 360) % 360;
    let elDeg = toDegrees(look.elevation);

    [azDeg, elDeg] = applyTilt(azDeg, elDeg, tiltDeg, tiltAz);
    if (applyRef) elDeg = refractElevationDeg(elDeg, pressure, tempC);

    allResults.push([fmtISO(t), azDeg.toFixed(decimals()), elDeg.toFixed(decimals())]);

    if ((i % chunk) === 0 || i === nSteps - 1) {
      setProgress(Math.floor((i + 1) * 100 / nSteps));
      await new Promise(requestAnimationFrame);
    }
  }

  // Enable all-CSV download
  $('#downloadAllBtn').disabled = allResults.length === 0;
  $('#downloadAllBtn').onclick = () => {
    if (!allResults.length) return;
    downloadCsv('all_results.csv', ['time_utc','az_deg','el_deg'], allResults);
  };

  // Grouping → Summary
  groupedPasses  = groupPositiveAzEl(allResults);
  groupedSummary = summarizeGroups(groupedPasses);
  renderGroupSummary(groupedSummary);
}

/* ======= Wire UI ======= */
window.addEventListener('DOMContentLoaded', () => {
  // Defaults for datetime-local (now .. +15 min)
  const now = new Date();
  const round = (ms, step) => new Date(Math.ceil(ms / step) * step);
  const step = 60_000; // to minutes
  const start = round(now.getTime(), step);
  const end = new Date(start.getTime() + 15 * 60_000);

  const fmtLocal = (d) => {
    const z = (n, w=2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
  };
  $('#startTime').value = fmtLocal(start);
  $('#endTime').value   = fmtLocal(end);

  $('#generateBtn').addEventListener('click', generate);
  $('#downloadGroupsZipBtn').addEventListener('click', downloadGroupsZip);
});
