// app.js
// Updated: pagination + CSV download + robust gstime detection

// --- Utilities (refraction + tilt + CSV) ---
function pressureMbarBarometric(hMeters, p0Mbar = 1013.25) {
  const T0 = 288.15, L = 0.0065, g = 9.80665, M = 0.0289644, R = 8.3144598;
  return p0Mbar * Math.pow(1.0 - (L * hMeters) / T0, (g * M) / (R * L));
}

function refractBennettDeg(altitudeDeg, tempC = 15.0, pressureMbar = 1013.25) {
  if (altitudeDeg <= -1.0) return altitudeDeg;
  const altRad = altitudeDeg * Math.PI / 180;
  const R_arcmin = (pressureMbar / 1010.0) * (283.0 / (273.0 + tempC)) *
    (1.02 / Math.tan(altRad + (10.3 / (altitudeDeg + 5.11)) * Math.PI / 180));
  return altitudeDeg + R_arcmin / 60.0;
}

function applyTilt(azDeg, elDeg, tiltDeg, tiltAzDeg) {
  const az = azDeg * Math.PI / 180, el = elDeg * Math.PI / 180;
  const xE = Math.cos(el) * Math.sin(az);
  const yN = Math.cos(el) * Math.cos(az);
  const zU = Math.sin(el);
  const tAz = tiltAzDeg * Math.PI / 180;
  const ax = Math.sin(tAz), ay = Math.cos(tAz), azAxis = 0.0;
  const theta = tiltDeg * Math.PI / 180;
  const kDotV = ax * xE + ay * yN + azAxis * zU;
  const kxVx = ay * zU - azAxis * yN;
  const kxVy = azAxis * xE - ax * zU;
  const kxVz = ax * yN - ay * xE;

  const xR = xE * Math.cos(theta) + kxVx * Math.sin(theta) + ax * kDotV * (1.0 - Math.cos(theta));
  const yR = yN * Math.cos(theta) + kxVy * Math.sin(theta) + ay * kDotV * (1.0 - Math.cos(theta));
  const zR = zU * Math.cos(theta) + kxVz * Math.sin(theta) + azAxis * kDotV * (1.0 - Math.cos(theta));

  const elTiltDeg = Math.asin(Math.max(-1, Math.min(1, zR))) * 180.0 / Math.PI;
  let azTiltDeg = Math.atan2(xR, yR) * 180.0 / Math.PI;
  if (azTiltDeg < 0) azTiltDeg += 360.0;
  return [azTiltDeg, elTiltDeg];
}

function formatUtcSeconds(d) {
  // "YYYY-MM-DD HH:mm:ss"
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${hh}:${mm}:${ss}`;
}

function downloadCsv(filename, headerRow, rows) {
  // headerRow: array of column names
  // rows: array of arrays
  if (!rows || rows.length === 0) {
    alert('No data to download.');
    return;
  }
  const esc = field => {
    if (field == null) return '""';
    const s = String(field).replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [headerRow.map(esc).join(',')];
  for (const r of rows) lines.push(r.map(esc).join(','));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// --- GSTIME compatibility ---
function getGmst(date) {
  if (typeof satellite.gstime === 'function') return satellite.gstime(date);
  if (typeof satellite.gstimeFromDate === 'function') return satellite.gstimeFromDate(date);
  // As a last resort attempt common alternate name:
  if (typeof satellite.siderealTime === 'function') return satellite.siderealTime(date);
  throw new Error('satellite.js GSTIME function not found (tried gstime, gstimeFromDate, siderealTime). Please check your satellite.js build.');
}

// --- global state for paging + results ---
let allResults = [];      // array of [timeStr, azStr, elStr]
let currentPage = 1;
let rowsPerPage = 20;  // change if you want smaller/larger pages

// --- DOM helpers ---
function showControls(show) {
  const controls = document.getElementById('controls');
  if (!controls) return;
  controls.classList.toggle('hidden', !show);
}

function showProgress(show) {
  const progressContainer = document.getElementById('progressContainer');
  if (!progressContainer) return;
  progressContainer.classList.toggle('hidden', !show);
}

// --- paging / rendering ---
function renderPage(page = 1) {
  if (!Array.isArray(allResults)) return;
  const total = allResults.length;
  const pageCount = Math.max(1, Math.ceil(total / rowsPerPage));
  if (page < 1) page = 1;
  if (page > pageCount) page = pageCount;
  currentPage = page;

  // slice results
  const startIdx = (currentPage - 1) * rowsPerPage;
  const endIdx = Math.min(total, startIdx + rowsPerPage);

  const table = document.getElementById('resultsTable');
  if (!table) return;
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';

  for (let i = startIdx; i < endIdx; i++) {
    const r = allResults[i];
    const tr = document.createElement('tr');
    const tdTime = document.createElement('td'); tdTime.textContent = r[0]; tr.appendChild(tdTime);
    const tdAz = document.createElement('td'); tdAz.textContent = r[1]; tr.appendChild(tdAz);
    const tdEl = document.createElement('td'); tdEl.textContent = r[2]; tr.appendChild(tdEl);
    tbody.appendChild(tr);
  }

  // show table & controls
  table.classList.remove('hidden');
  showControls(true);

  // update pageInfo
  const pageInfo = document.getElementById('pageInfo');
  if (pageInfo) {
    pageInfo.textContent = `Page ${currentPage} / ${pageCount} — showing ${startIdx + 1}–${endIdx} of ${total}`;
  }

  // enable/disable prev/next buttons
  const prev = document.getElementById('prevPage');
  const next = document.getElementById('nextPage');
  if (prev) prev.disabled = (currentPage <= 1);
  if (next) next.disabled = (currentPage >= pageCount);

  // enable download buttons if data exists
  const dlAll = document.getElementById('downloadCSV');
  const dlPage = document.getElementById('downloadPage');
  if (dlAll) dlAll.disabled = total === 0;
  if (dlPage) dlPage.disabled = total === 0;
}

// --- form submit / generator ---
document.getElementById('tleForm').addEventListener('submit', async (evt) => {
  evt.preventDefault();

  // read fields
  const tleLine1 = document.getElementById('tleLine1').value.trim();
  const tleLine2 = document.getElementById('tleLine2').value.trim();
  const siteLat = parseFloat(document.getElementById('siteLat').value);
  const siteLon = parseFloat(document.getElementById('siteLon').value);
  const siteAltM = parseFloat(document.getElementById('siteAltM').value || '0');
  const startVal = document.getElementById('startTime').value;
  const endVal = document.getElementById('endTime').value;
  const resolutionSeconds = parseFloat(document.getElementById('resolution').value || '1');
  const decimals = parseInt(document.getElementById('decimals') ? document.getElementById('decimals').value : '2', 10) || 2;
  const applyRefraction = !!document.getElementById('applyRefraction') && document.getElementById('applyRefraction').checked;
  const tiltAngle = parseFloat(document.getElementById('tiltAngle').value || '0');
  const tiltAzimuth = parseFloat(document.getElementById('tiltAzimuth').value || '0');

  if (!tleLine1 || !tleLine2) { alert('Please provide TLE lines'); return; }
  if (!startVal || !endVal) { alert('Please provide Start and End time'); return; }

  // parse start/end as UTC (datetime-local gives local; user had 'Z' appended earlier)
  // The uploaded index.html uses values like 2025-08-25T03:39:25 (no timezone). We'll treat them as UTC:
  const start = new Date(startVal + 'Z');
  const end = new Date(endVal + 'Z');
  if (isNaN(start) || isNaN(end) || start > end) { alert('Invalid start/end'); return; }

  const resolutionMs = Math.max(1, Math.floor(resolutionSeconds * 1000));
  const satrec = satellite.twoline2satrec(tleLine1, tleLine2);
  const pressureMbar = pressureMbarBarometric(siteAltM);

  // prepare UI
  showProgress(true);
  const prog = document.getElementById('progressBar');
  if (prog) prog.style.width = '0%';

  // generate rows in chunks so UI stays responsive
  allResults = [];
  const chunk = 200; // update UI every 200 steps
  const totalSteps = Math.max(1, Math.ceil((end - start) / resolutionMs) + 1);
  let step = 0;

  for (let t = start.getTime(); t <= end.getTime(); t += resolutionMs) {
    const date = new Date(t);
    const pv = satellite.propagate(satrec, date);
    if (pv && pv.position) {
      // robust GMST getter
      let gmst;
      try { gmst = getGmst(date); } catch (err) { console.error(err); alert(err.message); showProgress(false); return; }

      const posEcf = satellite.eciToEcf(pv.position, gmst);
      const observerGd = { longitude: siteLon * Math.PI / 180.0, latitude: siteLat * Math.PI / 180.0, height: siteAltM / 1000.0 };
      const look = satellite.ecfToLookAngles(observerGd, posEcf);
      let azDeg = look.azimuth * 180 / Math.PI;
      let elDeg = look.elevation * 180 / Math.PI;
      if (azDeg < 0) azDeg += 360;
      if (applyRefraction) elDeg = refractBennettDeg(elDeg, 15.0, pressureMbar);
      [azDeg, elDeg] = applyTilt(azDeg, elDeg, tiltAngle, tiltAzimuth);

      allResults.push([formatUtcSeconds(date), azDeg.toFixed(decimals), elDeg.toFixed(decimals)]);
    }
    step++;
    // periodic UI update
    if (step % chunk === 0) {
      const pct = Math.min(100, Math.round((step / totalSteps) * 100));
      if (prog) prog.style.width = pct + '%';
      // yield to UI
      // small pause to allow repaint & event handling
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 8));
    }
  }

  // finish
  if (prog) prog.style.width = '100%';
  showProgress(false);

  if (allResults.length === 0) {
    alert('No valid position samples produced for this TLE/time range.');
    renderPage(1); // will hide controls
    return;
  }

  // show first page
  renderPage(1);
});

// --- pagination / download handlers ---
// Prev / Next
const prevBtn = document.getElementById('prevPage');
const nextBtn = document.getElementById('nextPage');
const downloadAllBtn = document.getElementById('downloadCSV');
const downloadPageBtn = document.getElementById('downloadPage');

if (prevBtn) prevBtn.addEventListener('click', () => { renderPage(currentPage - 1); });
if (nextBtn) nextBtn.addEventListener('click', () => { renderPage(currentPage + 1); });

// Download full CSV
if (downloadAllBtn) downloadAllBtn.addEventListener('click', () => {
  if (!allResults || allResults.length === 0) { alert('No data to download'); return; }
  downloadCsv('tle_az_el.csv', ['time_utc', 'az_deg', 'el_deg'], allResults);
});

// Download current page
if (downloadPageBtn) downloadPageBtn.addEventListener('click', () => {
  if (!allResults || allResults.length === 0) { alert('No data to download'); return; }
  const startIdx = (currentPage - 1) * rowsPerPage;
  const endIdx = Math.min(allResults.length, startIdx + rowsPerPage);
  const pageRows = allResults.slice(startIdx, endIdx);
  downloadCsv(`tle_az_el_page${currentPage}.csv`, ['time_utc', 'az_deg', 'el_deg'], pageRows);
});

document.getElementById("rowsPerPage").addEventListener("change", (e) => {
  rowsPerPage = parseInt(e.target.value, 10);
  currentPage = 1; // reset to first page
  renderPage(currentPage);
});