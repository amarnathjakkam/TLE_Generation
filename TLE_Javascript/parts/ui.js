function renderTable(data, containerId) {
  if (!data.length) return;
  const container = document.getElementById(containerId);

  let html = "<table><thead><tr><th>Time (UTC)</th><th>Az (°)</th><th>El (°)</th></tr></thead><tbody>";
  data.forEach(row => {
    html += `<tr><td>${row[0]}</td><td>${row[1]}</td><td>${row[2]}</td></tr>`;
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}
