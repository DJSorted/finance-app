// Shared Excel helpers. sheets: [{ name, columns: [{ key, header, width }], rows: [{...}] }]
export function loadXLSX() {
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

// Reads an .xlsx, .xls or .csv file. Returns { sheetName: [ {header: value, ...}, ... ] }
export async function readWorkbook(file) {
  const XLSX = await loadXLSX();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheets = {};
  wb.SheetNames.forEach((name) => {
    sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: false });
  });
  return sheets;
}