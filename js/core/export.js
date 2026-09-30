// Shared Excel export. sheets: [{ name, columns: [{ key, header, width }], rows: [{...}] }]
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('Could not load the Excel library. Check your connection.'));
    document.head.append(s);
  });
}

export async function exportSheets(filename, sheets) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  sheets.forEach((s) => {
    const header = s.columns.map((c) => c.header);
    const rows = s.rows.map((r) => s.columns.map((c) => r[c.key] ?? ''));
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = s.columns.map((c) => ({ wch: c.width || 16 }));
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  });
  XLSX.writeFile(wb, filename);
}