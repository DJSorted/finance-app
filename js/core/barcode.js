// Barcodes: check digits, making in-store barcodes, finding an item from a scan, camera scanning,
// printing labels and previewing an item's web link.
// Barcode images come from JsBarcode (cdnjs). Camera scanning uses the browser's BarcodeDetector,
// or the barcode-detector package (jsDelivr) on browsers without one (iPhone, Windows desktop).
// A USB / Bluetooth scanner needs nothing here: it types the code and presses Enter.

import { ui } from './ui.js';
import { makeModal } from './attachments.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function btn(text, cls, onClick) {
  const b = el('button', `btn ${cls}`.trim(), text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
const field = (text, input, cls = '') => { const w = el('div', `field ${cls}`.trim()); w.append(el('label', '', text), input); return w; };
const checkField = (text, input) => { const w = el('div', 'field check'); input.type = 'checkbox'; input.style.width = 'auto'; w.append(input, el('label', '', text)); return w; };

/* ---------- check digits and formats ---------- */

// GS1 check digit for the digits before it (EAN-8, UPC-A, EAN-13, GTIN-14)
export function gtinCheckDigit(body) {
  let s = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i -= 1, w = w === 3 ? 1 : 3) s += Number(body[i]) * w;
  return String((10 - (s % 10)) % 10);
}
const isGtinLength = (c) => /^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(c);
const validGtin = (c) => isGtinLength(c) && gtinCheckDigit(c.slice(0, -1)) === c.slice(-1);

// Which symbology to print a barcode in
export function formatFor(value) {
  if (/^\d{13}$/.test(value) && validGtin(value)) return 'EAN13';
  if (/^\d{12}$/.test(value) && validGtin(value)) return 'UPC';
  if (/^\d{8}$/.test(value) && validGtin(value)) return 'EAN8';
  return 'CODE128';
}

// '' when the barcode is usable, otherwise what is wrong with it
export function barcodeProblem(code) {
  if (!code) return '';
  if (code.length > 48) return 'The barcode is too long (48 characters at most).';
  if (/[^\x20-\x7e]/.test(code)) return 'The barcode can only use plain letters, digits and symbols.';
  if (isGtinLength(code) && !validGtin(code)) {
    return `The last digit of ${code} does not match the barcode's check digit (it should be ${gtinCheckDigit(code.slice(0, -1))}). Check it was typed correctly.`;
  }
  return '';
}

// In-store EAN-13 barcodes: 20 + 10-digit running number + check digit. Numbers starting 20-29 are kept
// for use inside one business, so they are free and never clash with a manufacturer's barcode.
export function internalBarcodeMaker(existing) {
  let n = 0;
  existing.forEach((b) => { if (b && /^20\d{11}$/.test(b)) n = Math.max(n, Number(b.slice(2, 12))); });
  return () => {
    n += 1;
    const body = `20${String(n).padStart(10, '0')}`;
    return body + gtinCheckDigit(body);
  };
}

// The item a scan or typed code points at: its barcode first, then its item code.
// A UPC-A (12 digits) is also tried with the leading 0 a scanner may add to make it EAN-13, and the other way round.
export function findByScan(list, raw) {
  const q = String(raw || '').trim();
  if (!q) return null;
  const low = q.toLowerCase();
  const tries = [q];
  if (/^0\d{12}$/.test(q)) tries.push(q.slice(1));
  if (/^\d{12}$/.test(q)) tries.push(`0${q}`);
  for (const t of tries) {
    const hit = list.find((i) => i.barcode && i.barcode === t);
    if (hit) return hit;
  }
  return list.find((i) => i.barcode && i.barcode.toLowerCase() === low)
    || list.find((i) => i.code && i.code.toLowerCase() === low)
    || null;
}

/* ---------- barcode images ---------- */

export function loadJsBarcode() {
  if (window.JsBarcode) return Promise.resolve(window.JsBarcode);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsbarcode/3.11.6/JsBarcode.all.min.js';
    s.onload = () => (window.JsBarcode ? resolve(window.JsBarcode) : reject(new Error('The barcode library did not start.')));
    s.onerror = () => reject(new Error('Could not load the barcode library. Check your connection.'));
    document.head.append(s);
  });
}

// SVG markup that stretches to fill its box. The quiet zone (blank margin scanners need) is part of the image.
function barcodeSvg(JsBarcode, value) {
  const make = (format) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    JsBarcode(svg, value, { format, displayValue: false, margin: 0, marginLeft: 10, marginRight: 10, width: 2, height: 100, flat: true });
    return svg;
  };
  let svg;
  try { svg = make(formatFor(value)); } catch (e) { svg = make('CODE128'); }
  const w = parseFloat(svg.getAttribute('width'));
  const h = parseFloat(svg.getAttribute('height'));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  ['width', 'height', 'style', 'x', 'y'].forEach((a) => svg.removeAttribute(a));
  return svg.outerHTML;
}

/* ---------- item link preview ---------- */

export const isImageUrl = (u) => /^https?:\/\/.+\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?(#.*)?$/i.test(u || '');

// Small cell content for a list: a thumbnail for a picture, otherwise a link
export function linkCellHtml(url) {
  if (!url) return '';
  if (isImageUrl(url)) {
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="Open picture"><img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="height:28px;max-width:48px;object-fit:cover;border-radius:4px;vertical-align:middle"></a>`;
  }
  return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open</a>`;
}

// A pop-up showing the item's picture or link, and its barcode
export async function showItemPreview(item, { price } = {}) {
  const { box, close } = makeModal(`${item.code} - ${item.name}`, 'modal wide');
  const url = item.link_url || '';
  if (url && isImageUrl(url)) {
    const img = el('img');
    img.src = url;
    img.alt = item.name;
    img.referrerPolicy = 'no-referrer';
    img.style.cssText = 'display:block;max-width:100%;max-height:55vh;margin:0 auto .75rem;border-radius:8px';
    img.addEventListener('error', () => img.replaceWith(el('p', 'muted', 'The picture could not be loaded. Check the link.')));
    box.append(img);
  } else if (url) {
    box.append(el('p', 'muted', 'This link is a web page, so it opens in a new tab.'));
  } else {
    box.append(el('p', 'muted', 'This item has no link. Add a picture or web page link on the item.'));
  }
  if (item.description) box.append(el('p', '', item.description));
  if (price) box.append(el('p', '', price));
  if (item.barcode) {
    const wrap = el('div');
    wrap.style.cssText = 'background:#fff;padding:8px;border-radius:6px;max-width:320px;margin:.5rem 0';
    const bars = el('div');
    bars.style.cssText = 'height:70px';
    wrap.append(bars, Object.assign(el('div', '', item.barcode), { style: 'color:#000;text-align:center;font:13px monospace;letter-spacing:1px' }));
    box.append(wrap);
    try { bars.innerHTML = barcodeSvg(await loadJsBarcode(), item.barcode); } catch (e) { bars.textContent = ''; }
    const svg = bars.querySelector('svg');
    if (svg) svg.style.cssText = 'width:100%;height:100%;display:block';
  }
  const actions = el('div', 'modal-actions');
  actions.append(el('span', 'spacer'));
  if (url) {
    const a = el('a', 'btn', 'Open link');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    actions.append(a);
  }
  actions.append(btn('Close', 'btn-primary', close));
  box.append(actions);
}

/* ---------- camera scanning ---------- */

const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'qr_code'];

async function makeDetector() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = SCAN_FORMATS.filter((f) => supported.includes(f));
      if (formats.length) return new window.BarcodeDetector({ formats });
    } catch (e) { /* fall back to the library */ }
  }
  const mod = await import('https://cdn.jsdelivr.net/npm/barcode-detector@2.3.1/dist/es/pure.min.js');
  return new mod.BarcodeDetector({ formats: SCAN_FORMATS });
}

function beep() {
  try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* ignore */ }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const a = new Ctx();
    const o = a.createOscillator();
    const g = a.createGain();
    o.frequency.value = 1400;
    g.gain.value = 0.08;
    o.connect(g).connect(a.destination);
    o.start();
    setTimeout(() => { o.stop(); a.close(); }, 90);
  } catch (e) { /* ignore */ }
}

// Scans with the phone or laptop camera.
// Single mode resolves with the first code read (or null when cancelled).
// Continuous mode calls onCode(code) for each new code and resolves null when Done is pressed;
// onCode may return a short message to show under the picture.
export function openScanner({ title = 'Scan with camera', continuous = false, onCode } = {}) {
  return new Promise((resolve) => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      ui.warn('This browser cannot use the camera here. The app must be opened over https (or on localhost).');
      resolve(null);
      return;
    }
    const { box, close } = makeModal(title, 'modal');
    const video = el('video');
    video.playsInline = true;
    video.muted = true;
    video.setAttribute('playsinline', '');
    video.style.cssText = 'width:100%;max-height:60vh;background:#000;border-radius:8px;display:block';
    const status = el('p', 'muted', 'Starting the camera...');
    const lastEl = el('p');
    const actions = el('div', 'modal-actions');
    actions.append(el('span', 'spacer'), btn(continuous ? 'Done' : 'Cancel', continuous ? 'btn-primary' : 'btn-ghost', () => finish(null)));
    box.append(video, status, lastEl, actions);

    let stream = null;
    let stopped = false;
    let lastCode = '';
    let lastAt = 0;

    function finish(code) {
      if (stopped) return;
      stopped = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (box.isConnected) close();
      resolve(code);
    }

    async function loop(detector) {
      while (!stopped) {
        if (!box.isConnected) { finish(null); return; } // closed with Escape
        try {
          if (video.readyState >= 2) {
            const found = await detector.detect(video);
            const raw = found.length ? String(found[0].rawValue || '').trim() : '';
            const now = Date.now();
            if (raw && (raw !== lastCode || now - lastAt > 1500)) {
              lastCode = raw;
              lastAt = now;
              beep();
              if (!continuous) { finish(raw); return; }
              const msg = onCode ? await onCode(raw) : '';
              lastEl.textContent = msg || `Read ${raw}`;
            } else if (raw) lastAt = now; // still in view: do not count it twice
          }
        } catch (e) { /* a frame that cannot be read */ }
        await new Promise((r) => setTimeout(r, 180));
      }
    }

    (async () => {
      try {
        const [detector, s] = await Promise.all([
          makeDetector(),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false }),
        ]);
        stream = s;
        if (stopped) { finish(null); return; }
        video.srcObject = stream;
        await video.play();
        status.textContent = continuous
          ? 'Point the camera at each barcode. Each new barcode is added; press Done when finished.'
          : 'Point the camera at the barcode.';
        loop(detector);
      } catch (e) {
        const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
        status.textContent = denied
          ? 'The camera was blocked. Allow camera access for this site in the browser settings, then try again.'
          : (e && e.name === 'NotFoundError' ? 'No camera was found on this device.' : `The camera could not start: ${(e && e.message) || e}`);
        status.className = 'bad';
      }
    })();
  });
}

/* ---------- labels ---------- */

// Sheet sizes match the common Avery / Tower A4 label sheets. Roll sizes print one label per page on a label printer.
const LAYOUTS = {
  'a4-21': { text: 'A4 sheet, 21 per page (63.5 × 38.1 mm)', cols: 3, rows: 7, w: 63.5, h: 38.1, top: 15.15, left: 7.25, gapX: 2.5, gapY: 0 },
  'a4-24': { text: 'A4 sheet, 24 per page (70 × 37 mm)', cols: 3, rows: 8, w: 70, h: 37, top: 0.5, left: 0, gapX: 0, gapY: 0 },
  'a4-40': { text: 'A4 sheet, 40 per page (48.5 × 25.4 mm)', cols: 4, rows: 10, w: 48.5, h: 25.4, top: 21.5, left: 8, gapX: 0, gapY: 0 },
  'a4-65': { text: 'A4 sheet, 65 per page (38.1 × 21.2 mm)', cols: 5, rows: 13, w: 38.1, h: 21.2, top: 10.7, left: 4.75, gapX: 2.5, gapY: 0 },
  'roll-50x25': { text: 'Label printer, 50 × 25 mm', roll: true, w: 50, h: 25 },
  'roll-38x25': { text: 'Label printer, 38 × 25 mm', roll: true, w: 38, h: 25 },
  'roll-58x40': { text: 'Label printer, 58 × 40 mm', roll: true, w: 58, h: 40 },
  'roll-100x50': { text: 'Label printer, 100 × 50 mm', roll: true, w: 100, h: 50 },
};
const PREF_KEY = 'label-print-options';
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
}

// Pick the items and how many labels of each. Resolves [{ item, qty }] or null.
export function pickLabelItems(list) {
  return new Promise((resolve) => {
    const { box, close } = makeModal('Print labels: choose items', 'modal xwide');
    const search = el('input');
    search.type = 'search';
    search.placeholder = 'Search code, name or barcode';
    search.style.cssText = 'width:100%;margin-bottom:.5rem';
    const onlyBar = el('input');
    const tools = el('div');
    tools.style.cssText = 'display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:.5rem';
    const wrapT = el('div', 'table-wrap');
    wrapT.style.cssText = 'max-height:50vh;overflow:auto';
    const count = el('span', 'muted');
    const qty = new Map(); // item id -> labels wanted
    const items = list.filter((i) => i.is_active !== false);

    const shown = () => {
      const q = search.value.trim().toLowerCase();
      return items.filter((i) => (!onlyBar.checked || i.barcode)
        && (!q || [i.code, i.name, i.barcode].some((x) => String(x || '').toLowerCase().includes(q))));
    };
    function render() {
      const rows = shown();
      wrapT.innerHTML = `<table class="grid"><thead><tr><th></th><th>Code</th><th>Name</th><th>Barcode</th><th>Labels</th></tr></thead><tbody>${
        rows.slice(0, 500).map((i) => `<tr data-id="${esc(i.id)}"><td><input type="checkbox" style="width:auto" ${qty.has(i.id) ? 'checked' : ''}></td>
          <td>${esc(i.code)}</td><td>${esc(i.name)}</td><td>${i.barcode ? esc(i.barcode) : '<span class="muted">uses the item code</span>'}</td>
          <td><input type="number" min="1" step="1" value="${qty.get(i.id) || 1}" style="width:5rem" ${qty.has(i.id) ? '' : 'disabled'}></td></tr>`).join('')
      }</tbody></table>${rows.length > 500 ? '<p class="muted">Showing the first 500. Search to narrow the list.</p>' : ''}`;
      sumUp();
    }
    function sumUp() {
      let n = 0;
      qty.forEach((v) => { n += v; });
      count.textContent = `${qty.size} item(s), ${n} label(s)`;
    }
    wrapT.addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      const [cb, q] = tr.querySelectorAll('input');
      if (e.target === cb) {
        q.disabled = !cb.checked;
        if (cb.checked) qty.set(tr.dataset.id, Math.max(1, Math.floor(Number(q.value)) || 1)); else qty.delete(tr.dataset.id);
      } else if (cb.checked) qty.set(tr.dataset.id, Math.max(1, Math.floor(Number(q.value)) || 1));
      sumUp();
    });
    wrapT.addEventListener('input', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (tr && e.target.type === 'number' && qty.has(tr.dataset.id)) { qty.set(tr.dataset.id, Math.max(1, Math.floor(Number(e.target.value)) || 1)); sumUp(); }
    });
    search.addEventListener('input', render);
    onlyBar.addEventListener('change', render);
    tools.append(
      btn('Tick all shown', '', () => { shown().forEach((i) => { if (!qty.has(i.id)) qty.set(i.id, 1); }); render(); }),
      btn('Clear', '', () => { qty.clear(); render(); }),
      checkField('Only items with a barcode', onlyBar),
      el('span', 'spacer'), count,
    );
    box.append(search, tools, wrapT);
    const actions = el('div', 'modal-actions');
    actions.append(el('span', 'spacer'), btn('Cancel', 'btn-ghost', () => { close(); resolve(null); }), btn('Next', 'btn-primary', () => {
      if (!qty.size) return ui.warn('Tick at least one item.');
      close();
      resolve(items.filter((i) => qty.has(i.id)).map((i) => ({ item: i, qty: qty.get(i.id) })));
    }));
    box.append(actions);
    render();
    search.focus();
  });
}

// Choose the label layout and what to show, then print.
// entries: [{ item, qty }]; priceText(item, inclTax) gives the price to print, or '' for none.
export async function printLabels(entries, { priceText = () => '' } = {}) {
  const prefs = { layout: 'a4-21', name: true, price: true, inclTax: true, code: false, digits: true, ...loadPrefs() };
  const node = el('div', 'form-grid');
  const layoutSel = el('select');
  Object.entries(LAYOUTS).forEach(([k, l]) => { const o = el('option', '', l.text); o.value = k; layoutSel.append(o); });
  layoutSel.value = LAYOUTS[prefs.layout] ? prefs.layout : 'a4-21';
  const qtyIn = el('input');
  qtyIn.type = 'number'; qtyIn.min = '1'; qtyIn.step = '1'; qtyIn.value = String(entries.length === 1 ? entries[0].qty : 1);
  const skipIn = el('input');
  skipIn.type = 'number'; skipIn.min = '0'; skipIn.step = '1'; skipIn.value = '0';
  const nameCb = el('input'); nameCb.checked = !!prefs.name;
  const priceCb = el('input'); priceCb.checked = !!prefs.price;
  const taxCb = el('input'); taxCb.checked = !!prefs.inclTax;
  const codeCb = el('input'); codeCb.checked = !!prefs.code;
  const digitsCb = el('input'); digitsCb.checked = !!prefs.digits;
  node.append(field('Label size', layoutSel, 'full'));
  if (entries.length === 1) node.append(field('Number of labels', qtyIn));
  const skipWrap = field('Labels already used on the first sheet', skipIn);
  node.append(skipWrap, checkField('Item name', nameCb), checkField('Sales price', priceCb), checkField('Price includes tax', taxCb), checkField('Item code', codeCb), checkField('Barcode digits under the bars', digitsCb));
  const note = el('p', 'muted full', 'Items without a barcode print their item code as a Code 128 barcode. In the print dialog choose 100% / actual size and no margins or headers.');
  note.style.gridColumn = '1 / -1';
  node.append(note);
  const syncSkip = () => { skipWrap.style.display = LAYOUTS[layoutSel.value].roll ? 'none' : ''; };
  layoutSel.addEventListener('change', syncSkip);
  syncSkip();

  const res = await ui.dialog({ title: 'Print labels', node, dismissValue: false,
    buttons: [{ label: 'Cancel', value: false, className: 'btn-ghost' }, { label: 'Print', value: true, className: 'btn-primary' }] });
  if (!res) return;
  const opts = { layout: layoutSel.value, name: nameCb.checked, price: priceCb.checked, inclTax: taxCb.checked, code: codeCb.checked, digits: digitsCb.checked };
  savePrefs(opts);
  if (entries.length === 1) entries = [{ item: entries[0].item, qty: Math.max(1, Math.floor(Number(qtyIn.value)) || 1) }];

  let JsBarcode;
  try { JsBarcode = await loadJsBarcode(); } catch (e) { ui.errorFrom(e); return; }
  const L = LAYOUTS[opts.layout];
  const fs = Math.max(1.7, Math.min(3.4, L.h * 0.085)); // text size in mm, from the label height
  const svgCache = new Map();
  const one = (item) => {
    const value = item.barcode || item.code;
    if (!svgCache.has(value)) svgCache.set(value, barcodeSvg(JsBarcode, value));
    const price = opts.price ? priceText(item, opts.inclTax) : '';
    const foot = [opts.code ? `<span>${esc(item.code)}</span>` : '', price ? `<b>${esc(price)}</b>` : ''].filter(Boolean).join('');
    // Digit size in mm: grows with label height, but never wider than the label allows for this many characters
    const dgSize = Math.max(2.2, Math.min(L.h * 0.15, 6, (L.w - 4) / (value.length * 0.68)));
    return `${opts.name ? `<div class="nm">${esc(item.name)}</div>` : ''}<div class="bc">${svgCache.get(value)}</div>`
      + `${opts.digits ? `<div class="dg" style="font-size:${dgSize.toFixed(2)}mm">${esc(value)}</div>` : ''}${foot ? `<div class="ft">${foot}</div>` : ''}`;
  };
  const labels = [];
  entries.forEach(({ item, qty }) => { for (let i = 0; i < qty; i += 1) labels.push(one(item)); });
  if (labels.length > 5000) { ui.warn('That is more than 5000 labels. Print them in smaller batches.'); return; }

  let body;
  let pageCss;
  if (L.roll) {
    pageCss = `@page{size:${L.w}mm ${L.h}mm;margin:0}`;
    body = labels.map((l) => `<div class="lbl roll">${l}</div>`).join('');
  } else {
    pageCss = '@page{size:A4;margin:0}';
    const per = L.cols * L.rows;
    const skip = Math.min(per - 1, Math.max(0, Math.floor(Number(skipIn.value)) || 0));
    const slots = [...Array(skip).fill(null), ...labels];
    const pages = [];
    for (let p = 0; p < slots.length; p += per) {
      pages.push(`<div class="page">${slots.slice(p, p + per).map((l, i) => {
        if (l === null) return '';
        const c = i % L.cols;
        const r = Math.floor(i / L.cols);
        return `<div class="lbl" style="left:${L.left + c * (L.w + L.gapX)}mm;top:${L.top + r * (L.h + L.gapY)}mm">${l}</div>`;
      }).join('')}</div>`);
    }
    body = pages.join('');
  }
  const css = `${pageCss}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000;font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .page{position:relative;width:210mm;height:297mm;overflow:hidden;page-break-after:always;break-after:page}
    .page:last-child{page-break-after:auto;break-after:auto}
    .lbl{position:absolute;width:${L.w}mm;height:${L.h}mm;padding:1.2mm 2mm;display:flex;flex-direction:column;overflow:hidden;font-size:${fs}mm;line-height:1.15}
    .lbl.roll{position:relative;page-break-after:always;break-after:page}
    .lbl.roll:last-child{page-break-after:auto;break-after:auto}
    .nm{font-weight:bold;max-height:2.3em;overflow:hidden;text-align:center;margin-bottom:.4mm}
    .bc{flex:1 1 auto;min-height:0}
    .bc svg{width:100%;height:100%;display:block}
    .dg{text-align:center;font-family:monospace;font-weight:bold;letter-spacing:.06em;line-height:1.1;white-space:nowrap}
    .ft{display:flex;justify-content:space-between;gap:1mm;white-space:nowrap}
    .ft b:only-child{margin-left:auto;margin-right:auto}`;

  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.append(f);
  const w = f.contentWindow;
  w.document.open();
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>${css}</style></head><body>${body}</body></html>`);
  w.document.close();
  setTimeout(() => {
    w.focus();
    w.print();
    setTimeout(() => f.remove(), 1500);
  }, 150);
}