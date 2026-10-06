// Shared Excel helpers.
// exportSheets writes a formatted workbook (ExcelJS): company and report title rows, number and date formats,
// a filter on the header row, and totals that recalculate when you filter inside Excel.
// readWorkbook reads an uploaded .xlsx/.xls/.csv file (SheetJS).
//
// Sheet options: name, title, subtitle, columns [{ key, header, width, format, total }], rows,
//   totals: false          no totals row
//   plain: true            header on row 1, no title rows, no totals (for import templates)
//   styleCell(row, col, value) -> { fill, color, bold }   hex colours without #
//   notes: [text lines]    printed under the data

let exportContext = { company: '' };
export function setExportContext(info) { exportContext = { ...exportContext, ...info }; }

/* ---------- SheetJS: reading files, and a plain fallback ---------- */

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

const safeName = (n) => String(n || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';

async function exportPlain(filename, sheets) {
  const XLSX = await loadXLSX();
  const wb = XLSX.utils.book_new();
  sheets.forEach((s) => {
    const header = s.columns.map((c) => c.header);
    const rows = (s.rows || []).map((r) => s.columns.map((c) => r[c.key] ?? ''));
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws['!cols'] = s.columns.map((c) => ({ wch: c.width || 16 }));
    XLSX.utils.book_append_sheet(wb, ws, safeName(s.name));
  });
  XLSX.writeFile(wb, filename);
}

/* ---------- ExcelJS: the formatted export ---------- */

function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
    s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('The Excel formatting library did not start.')));
    s.onerror = () => reject(new Error('Could not load the Excel formatting library.'));
    document.head.append(s);
  });
}

// Columns that should not be added up: rates, prices, averages, balances, quantities, days, percentages
const NO_TOTAL = /(rate|price|average|avg|unit cost|%|percent|balance|owed|days|sort|level|period|months|\bage\b|units|qty|quantity|number|\bno\b|year|limit|digits|minimum|replacement|extra|event)/i;
const COUNT_HEADER = /(qty|quantity|units|count|days|months|assets|\bno\b|level|sort|digits|lines|number)/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function decimalsOf(n) {
  const s = String(Math.round(n * 1e6) / 1e6);
  const i = s.indexOf('.');
  return i < 0 ? 0 : s.length - i - 1;
}
function numFormat(header, nums) {
  const maxDec = Math.min(6, Math.max(0, ...nums.map(decimalsOf)));
  if (maxDec === 0 && COUNT_HEADER.test(header)) return '#,##0_);[Red](#,##0)';
  const core = '#,##0.00' + '#'.repeat(Math.max(2, maxDec) - 2);
  return `${core}_);[Red](${core})`;
}
const fill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${hex}` } });

function writeSheet(wb, sheet, used) {
  const cols = sheet.columns;
  const rows = sheet.rows || [];
  const plain = !!sheet.plain;

  let name = safeName(sheet.name);
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${safeName(sheet.name).slice(0, 28)} ${n++}`;
  used.add(name.toLowerCase());
  const ws = wb.addWorksheet(name);

  let hdr = 1;
  if (!plain) {
    ws.getCell(1, 1).value = exportContext.company || 'Finance App';
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.getCell(2, 1).value = sheet.title || sheet.name;
    ws.getCell(2, 1).font = { bold: true, size: 12 };
    ws.getCell(3, 1).value = [sheet.subtitle, `Generated ${stamp()}`].filter(Boolean).join('   ·   ');
    ws.getCell(3, 1).font = { italic: true, color: { argb: 'FF6B7280' } };
    hdr = 5;
  }

  // what kind of data is in each column
  const kinds = cols.map((c) => {
    const present = rows.map((rw) => rw[c.key]).filter((v) => v !== '' && v !== null && v !== undefined);
    if (present.length && present.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return { num: true, fmt: c.format || numFormat(c.header, present) };
    }
    if (present.length && present.every((v) => typeof v === 'string' && ISO_DATE.test(v))) return { date: true };
    return {};
  });

  // header
  const hr = ws.getRow(hdr);
  cols.forEach((c, i) => {
    const cell = hr.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = fill('1F2937');
    cell.alignment = { horizontal: kinds[i].num ? 'right' : 'left', vertical: 'middle', wrapText: true };
    ws.getColumn(i + 1).width = c.width || Math.max(12, String(c.header).length + 3);
  });
  hr.height = 22;

  // data
  rows.forEach((rw, ri) => {
    const row = ws.getRow(hdr + 1 + ri);
    cols.forEach((c, ci) => {
      const v = rw[c.key];
      const k = kinds[ci];
      const cell = row.getCell(ci + 1);
      if (v !== '' && v !== null && v !== undefined) {
        if (k.num) cell.value = v;
        else if (k.date) { const [y, m, d] = v.split('-').map(Number); cell.value = new Date(Date.UTC(y, m - 1, d)); }
        else cell.value = String(v);
      }
      if (k.num) { cell.numFmt = k.fmt; cell.alignment = { horizontal: 'right' }; }
      else if (k.date) { cell.numFmt = 'yyyy-mm-dd'; cell.alignment = { horizontal: 'left' }; }
      if (ri % 2 === 1) cell.fill = fill('F3F4F6');
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFD1D5DB' } } };
      if (sheet.styleCell) {
        const st = sheet.styleCell(rw, c, v);
        if (st) {
          if (st.fill) cell.fill = fill(st.fill);
          if (st.color || st.bold) cell.font = { bold: !!st.bold, color: st.color ? { argb: `FF${st.color}` } : undefined };
        }
      }
    });
  });

  // totals
  let last = hdr + rows.length;
  const totalCols = cols.map((c, i) => i).filter((i) => kinds[i].num
    && (cols[i].total === true || (cols[i].total !== false && !NO_TOTAL.test(String(cols[i].header)))));
  if (!plain && sheet.totals !== false && rows.length && totalCols.length) {
    const first = hdr + 1;
    const L = (i) => colLetter(i + 1);
    const curIdx = cols.findIndex((c) => /^(currency|cur)$/i.test(String(c.header).trim()));
    const currencies = curIdx >= 0 ? [...new Set(rows.map((r) => r[cols[curIdx].key]).filter(Boolean))] : [];
    const multi = currencies.length > 1;
    const labelCol = cols.findIndex((c, i) => !totalCols.includes(i));
    const sumOf = (i, cur) => rows.reduce((s, rw) => (cur === undefined || rw[cols[curIdx].key] === cur
      ? s + (Number(rw[cols[i].key]) || 0) : s), 0);
    let tr = last + 1;
    const addRow = (label, which, formulaFor, valueFor) => {
      const row = ws.getRow(tr);
      for (let c = 1; c <= cols.length; c++) {
        const cell = row.getCell(c);
        cell.font = { bold: true };
        cell.fill = fill('E5E7EB');
        cell.border = { top: { style: 'thin', color: { argb: 'FF6B7280' } } };
      }
      if (labelCol >= 0) row.getCell(labelCol + 1).value = label;
      which.forEach((i) => {
        const cell = row.getCell(i + 1);
        cell.value = { formula: formulaFor(i), result: valueFor(i) };
        cell.numFmt = kinds[i].fmt;
        cell.alignment = { horizontal: 'right' };
      });
      tr++;
    };
    const rng = (i) => `${L(i)}${first}:${L(i)}${last}`;
    const subtotal = (i) => `SUBTOTAL(109,${rng(i)})`;
    if (!multi) {
      addRow('Total', totalCols, subtotal, (i) => sumOf(i));
    } else {
      const isBase = (i) => /\([A-Z]{3}\)/.test(String(cols[i].header));
      const baseCols = totalCols.filter(isBase);
      const docCols = totalCols.filter((i) => !isBase(i));
      if (baseCols.length) addRow('Total', baseCols, subtotal, (i) => sumOf(i));
      if (docCols.length) {
        const cr = `$${L(curIdx)}$${first}:$${L(curIdx)}$${last}`;
        currencies.forEach((cur) => addRow(`Total ${cur}`, docCols,
          (i) => `SUMIF(${cr},"${cur}",${rng(i)})`, (i) => sumOf(i, cur)));
      }
    }
    last = tr - 1;
  }

  if (sheet.notes && sheet.notes.length) {
    let r = last + 2;
    sheet.notes.forEach((t) => { ws.getCell(r, 1).value = t; ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF6B7280' } }; r++; });
  }

  ws.views = [{ state: 'frozen', ySplit: hdr }];
  if (rows.length) ws.autoFilter = { from: { row: hdr, column: 1 }, to: { row: hdr + rows.length, column: cols.length } };
  ws.pageSetup = {
    orientation: cols.length > 7 ? 'landscape' : 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    printTitlesRow: `${hdr}:${hdr}`,
  };
  ws.headerFooter.oddFooter = '&L&8Finance App&R&8Page &P of &N';
}

export async function exportSheets(filename, sheets) {
  let ExcelJS;
  try { ExcelJS = await loadExcelJS(); } catch (e) { return exportPlain(filename, sheets); }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Finance App';
  wb.created = new Date();
  const used = new Set();
  sheets.forEach((s) => writeSheet(wb, s, used));
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}