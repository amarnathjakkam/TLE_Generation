// CSV utility
function exportToCsv(filename, rows) {
  if (!rows || !rows.length) return;
  const processRow = row => row.map(field => `"${field}"`).join(",");
  const csvContent = rows.map(processRow).join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
