/* ═══════════════════════════════════════════════════════════════════════════
   sprout-book.js — a whole story as pictures of its pages, and as a PDF.

   Loaded by BOTH workshop-plugin.html (preview, PDF export, local printing)
   and teacher.html (reading a collected book, printed-book orders), so the
   book a child exports and the book a teacher orders are drawn the same way.

   Needs Fabric (vendor/fabric.min.js) loaded first. A classic script, not a
   module, for the same reason as sprout-sync.js: the Studio must keep working
   when opened straight off disk.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// Physical trim for the page sizes the Studio offers, long side × short side
// in inches (see PAGE_SIZES in workshop-plugin.html). Sizes with no physical
// meaning (Standard, Square, Screen, Widescreen) come out 10 in on the long side.
const TRIM_IN = {
  letter: [11, 8.5], a4: [11.69, 8.27], book810: [10, 8], book69: [9, 6], photo57: [7, 5],
};
const PRINT_LONG_PX = 2400;   // 240 dpi at 10 in. Pip's pictures are 1536 px, so more adds bytes, not detail.

function pageSize(story) {
  return { w: story.page?.w || 800, h: story.page?.h || 540 };
}

function trim(story) {
  const { w, h } = pageSize(story);
  const [long, short] = TRIM_IN[story.page?.size] || [10, 10 * Math.min(w, h) / Math.max(w, h)];
  const landscape = w >= h;
  return {
    wIn: landscape ? long : short, hIn: landscape ? short : long,
    label: `${+(landscape ? long : short).toFixed(2)} × ${+(landscape ? short : long).toFixed(2)} in`,
  };
}

// Every font a page's text uses, so it is loaded before the page is drawn.
// Drawing first would bake the fallback font into the picture.
function fontsIn(story) {
  const fams = new Set(['Nunito']);
  for (const s of story.slides || []) {
    if (!s.json) continue;
    let objs;
    try { objs = JSON.parse(s.json).objects || []; } catch { continue; }
    for (const o of objs) if (o.fontFamily) fams.add(String(o.fontFamily).split(',')[0].replace(/['"]/g, '').trim());
  }
  return [...fams];
}

// One JPEG per page, in order, at `longPx` on the long side. White behind
// everything: JPEG has no transparency, and a page saved without a background
// would come out black. Anything placed off the page is cut off at its edge,
// as it would be on paper.
async function renderPages(story, { longPx = PRINT_LONG_PX, quality = 0.88, onPage } = {}) {
  for (const f of fontsIn(story)) {
    try { await document.fonts.load(`16px "${f}"`); await document.fonts.load(`bold 16px "${f}"`); } catch {}
  }
  const { w, h } = pageSize(story);
  const scale = longPx / Math.max(w, h);
  const canvas = new fabric.StaticCanvas(document.createElement('canvas'), { width: w, height: h, enableRetinaScaling: false });
  const pages = [];
  try {
    for (let i = 0; i < (story.slides || []).length; i++) {
      if (onPage) onPage(i);
      const json = story.slides[i].json;
      canvas.clear();
      if (json) await new Promise(resolve => canvas.loadFromJSON(json, resolve));
      if (!canvas.backgroundColor) canvas.backgroundColor = '#FFFFFF';
      canvas.renderAll();
      const el = canvas.toCanvasElement(scale);
      const blob = await new Promise(resolve => el.toBlob(resolve, 'image/jpeg', quality));
      pages.push({ blob, jpeg: new Uint8Array(await blob.arrayBuffer()), w: el.width, h: el.height });
    }
  } finally {
    canvas.dispose();
  }
  return pages;
}

// A minimal PDF: one page per JPEG, each image filling its page. JPEG is a
// native PDF image format (DCTDecode), so the bytes go in unchanged and no
// library is needed.
function buildPdf(pages, wPt, hPt) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const add = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, ...body) => { offsets[n] = size; add(n + ' 0 obj\n'); body.forEach(add); add('\nendobj\n'); };
  const W = wPt.toFixed(2), H = hPt.toFixed(2);

  add('%PDF-1.4\n');
  add(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));   // binary marker, so tools don't treat it as text
  const kids = pages.map((_, i) => (3 + i * 3) + ' 0 R').join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const page = 3 + i * 3, content = page + 1, image = page + 2;
    const draw = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] ` +
              `/Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    obj(content, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(image, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB ` +
               `/BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream');
  });

  const count = 3 + pages.length * 3;
  const xref = size;
  add(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) add(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
  add(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// The whole book as a print-ready PDF at its physical trim size.
async function storyPdf(story, onPage) {
  const pages = await renderPages(story, { onPage });
  const t = trim(story);
  return { pdf: buildPdf(pages, t.wIn * 72, t.hIn * 72), pages: pages.length, trim: t };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

window.SproutBook = { trim, renderPages, buildPdf, storyPdf, blobToBase64 };

})();
