// Self-contained brief export — produces a themed, INTERACTIVE HTML document
// (or a themed PDF via the print dialog). The exported file inlines the app
// theme and a small standalone script so the collapsible card sections, the
// per-card tab bar, the NOTAM category filter, and the TAF raw/decoded toggle
// all keep working with no network and no dependency on app.js.
//
// This is distinct from the "Kneeboard PDF" button, which prints the live app
// in a light, ink-friendly layout. Export keeps the dark app theme.

// Standalone interaction handlers for the exported document. Kept dependency-
// free (plain DOM, no template literals/backticks) so it embeds cleanly.
const INTERACT_JS = `
(function () {
  var OPEN_DEFAULT = { RUNWAY: 1, APPROACH: 1, GPS_RAIM: 1 };
  document.addEventListener('click', function (e) {
    var head = e.target.closest && e.target.closest('.card > .head');
    if (head) { head.parentElement.classList.toggle('collapsed'); return; }

    var tab = e.target.closest('.card-tabs .tab');
    if (tab) {
      var cardEl = tab.closest('.card');
      var key = tab.getAttribute('data-tab');
      cardEl.querySelectorAll('.card-tabs .tab').forEach(function (x) { x.classList.toggle('active', x === tab); });
      cardEl.querySelectorAll('.tabpanel').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-panel') === key); });
      return;
    }

    var nf = e.target.closest('.nfilter');
    if (nf) {
      var cat = nf.getAttribute('data-cat');
      var bar = nf.parentElement;
      bar.querySelectorAll('.nfilter').forEach(function (c) { c.classList.remove('active'); });
      nf.classList.add('active');
      bar.parentElement.querySelectorAll('.ngroup').forEach(function (g) {
        var dc = g.getAttribute('data-cat');
        var match = cat === 'ALL' || dc === cat;
        g.hidden = !match;
        g.open = cat === 'ALL' ? !!OPEN_DEFAULT[dc] : true;
      });
      return;
    }

    var t = e.target.closest('[data-taf-raw]');
    if (t) {
      e.preventDefault();
      var wrap = t.closest('.tabpanel') || t.closest('.card');
      var raw = wrap.querySelector('.raw-taf');
      var dec = wrap.querySelector('.taf-decoded');
      var showRaw = raw.style.display === 'none';
      raw.style.display = showRaw ? 'block' : 'none';
      dec.style.display = showRaw ? 'none' : 'block';
      t.textContent = showRaw ? 'show decoded' : 'show raw';
    }
  });

  // Expand every section and un-hide filtered NOTAM groups for printing, then
  // restore — so a printed/saved PDF always contains the complete brief.
  window.addEventListener('beforeprint', function () {
    document.querySelectorAll('details.sec, details.ngroup').forEach(function (d) { d.dataset.wasopen = d.open ? '1' : '0'; d.open = true; });
    document.querySelectorAll('.ngroup[hidden]').forEach(function (g) { g.dataset.washidden = '1'; g.hidden = false; });
  });
  window.addEventListener('afterprint', function () {
    document.querySelectorAll('details.sec, details.ngroup').forEach(function (d) { if (d.dataset.wasopen === '0') d.open = false; });
    document.querySelectorAll('.ngroup[data-washidden="1"]').forEach(function (g) { g.hidden = true; delete g.dataset.washidden; });
  });
})();
`;

// Export-specific styles layered after the inlined theme: show the brief
// header, drop the (canvas) map, and keep the dark theme when printing.
const EXPORT_CSS = `
  body { padding: 16px; }
  .topbar { position: static; }
  .print-head { display: block; margin: 0 0 14px; }
  .map-section { display: none !important; }
  .export-note { font-size: 12px; color: var(--text-dim); margin: 0 0 14px; padding: 8px 10px; border: 1px dashed var(--border); border-radius: 8px; }
  @media print {
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    @page { margin: 12mm; }
    .topbar { position: static !important; }
    .export-note { display: none; }
    .card-tabs { display: none !important; }
    .tabpanel { display: block !important; border-top: 1px solid var(--border); margin-top: 8px; padding-top: 8px; }
    .raw-taf { display: none !important; }
    .card { break-inside: avoid; }
  }
`;

function exportFilename() {
  const ids = (document.getElementById('icaos')?.value || 'brief')
    .trim().split(/[\s,]+/).filter(Boolean).join('-').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40) || 'brief';
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
  return `c17-brief-${ids}-${stamp}.html`;
}

function buildExportHtml(themeCss, { autoprint } = {}) {
  const head = (document.getElementById('print-head') || {}).innerHTML || '';
  const results = (document.getElementById('results') || {}).innerHTML || '';
  const auto = autoprint
    ? "window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 250); });"
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0e14">
<title>C-17 Mission Brief</title>
<style>${themeCss}</style>
<style>${EXPORT_CSS}</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div>
      <h1>C-17 MISSION BRIEF</h1>
      <div class="subtitle">Exported brief · theme &amp; collapsible sections preserved</div>
    </div>
  </header>
  <div class="print-head">${head}</div>
  <div class="export-note">Interactive snapshot — click the section tabs, category chips, and card headers to expand/collapse. The live map and route tools are not included. Print this page (enable “Background graphics”) to save a themed PDF.</div>
  <main id="results">${results}</main>
  <footer class="footer">Planning aid only — verify with official sources.</footer>
</div>
<script>
${INTERACT_JS}
${auto}
<\/script>
</body>
</html>`;
}

// Inline the app theme, but drop its kneeboard @media print block (which flips
// to a light layout) so the export keeps the dark theme when printed.
async function loadThemeCss() {
  let css = '';
  try { css = await (await fetch('./theme.css', { cache: 'no-store' })).text(); } catch { /* inline nothing */ }
  const printIdx = css.lastIndexOf('@media print');
  return printIdx >= 0 ? css.slice(0, printIdx) : css;
}

/** Export the current brief. format: 'html' (download) or 'pdf' (print dialog). */
export async function exportBrief(format) {
  const results = document.getElementById('results');
  if (!results || !results.querySelector('.card')) {
    alert('Build a brief first, then export.');
    return;
  }
  const themeCss = await loadThemeCss();
  const doc = buildExportHtml(themeCss, { autoprint: format === 'pdf' });

  if (format === 'pdf') {
    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up blocked — allow pop-ups to export PDF, or use Export HTML.'); return; }
    w.document.open();
    w.document.write(doc);
    w.document.close();
    return;
  }

  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
