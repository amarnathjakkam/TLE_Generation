let allResults = [];

document.getElementById("tleForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const tleLine1 = document.getElementById("tleLine1").value.trim();
  const tleLine2 = document.getElementById("tleLine2").value.trim();
  const lat = parseFloat(document.getElementById("siteLat").value);
  const lon = parseFloat(document.getElementById("siteLon").value);
  const height = parseFloat(document.getElementById("siteHeight").value);
  const startDate = new Date(document.getElementById("startTime").value);
  const endDate = new Date(document.getElementById("endTime").value);
  const resolution = parseInt(document.getElementById("resolution").value);
  const tiltAz = parseFloat(document.getElementById("tiltAz").value);
  const tiltEl = parseFloat(document.getElementById("tiltEl").value);

  const progressBar = document.getElementById("progressBar");
  progressBar.value = 0;

  allResults = generateAzElData(
    tleLine1, tleLine2,
    lat, lon, height,
    startDate, endDate, resolution,
    tiltAz, tiltEl,
    (p) => progressBar.value = p
  );

  renderTable(allResults.slice(0, 50), "tableContainer"); // Preview only first 50
});

document.getElementById("downloadCsv").addEventListener("click", () => {
  exportToCsv("az_el_data.csv", allResults);
});

document.getElementById("downloadCsvPage").addEventListener("click", () => {
  const tableRows = Array.from(document.querySelectorAll("#tableContainer tbody tr"))
    .map(tr => Array.from(tr.querySelectorAll("td")).map(td => td.innerText));
  exportToCsv("az_el_page.csv", tableRows);
});
