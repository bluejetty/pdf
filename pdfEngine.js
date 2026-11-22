// Paper sizes in PDF points (72 per inch), portrait.
export const pageSizes = {
  '8.5x11': { width: 612, height: 792 },
  '8.5x14': { width: 612, height: 1008 },
  '11x17': { width: 792, height: 1224 },
  '24x36': { width: 1728, height: 2592 },
  'A4': { width: 595.28, height: 841.89 },
  'A3': { width: 841.89, height: 1190.55 },
};

const norm = (a) => (((Math.round(a / 90) * 90) % 360) + 360) % 360;

// Fit content of size cw x ch, turned r degrees clockwise, centred on a
// paper the size of `size`, whose orientation follows the turned content.
// Returns the paper size and the draw options for pdf-lib (whose `rotate`
// turns counter-clockwise about the x/y point).
export function placeOnPaper(cw, ch, r, size, k = 1) {
  const s0 = pageSizes[size] || pageSizes['8.5x11'];
  const vw = r % 180 ? ch : cw;
  const vh = r % 180 ? cw : ch;
  const landscape = vw > vh;
  const paperW = landscape ? s0.height : s0.width;
  const paperH = landscape ? s0.width : s0.height;
  const s = Math.min(paperW / vw, paperH / vh) * k;
  const sw = cw * s;
  const sh = ch * s;
  const X = (paperW - vw * s) / 2;
  const Y = (paperH - vh * s) / 2;
  const at = { 0: [X, Y], 90: [X, Y + sw], 180: [X + sw, Y + sh], 270: [X + sh, Y] }[r];
  return { paperW, paperH, x: at[0], y: at[1], width: sw, height: sh, rotate: -r };
}

export function getDims(size, orientation) {
  const s = pageSizes[size] || pageSizes['8.5x11'];
  return orientation === 'landscape'
    ? { width: s.height, height: s.width }
    : { width: s.width, height: s.height };
}

function wrapText(text, font, fontSize, maxWidth) {
  const paragraphs = text.split('\n');
  const lines = [];
  for (const para of paragraphs) {
    if (para.trim() === '') { lines.push(''); continue; }
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const testLine = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(testLine, fontSize) > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function buildPDF(items) {
  const { PDFDocument, rgb, StandardFonts, degrees } = window.PDFLib;
  const outDoc = await PDFDocument.create();
  const font = await outDoc.embedFont(StandardFonts.Helvetica);
  const included = items.filter((i) => (i.type === 'pdf' && Array.isArray(i.pages)
    ? i.pages.some((p) => p.include)
    : i.included));
  if (included.length === 0) throw new Error('No items selected to include.');

  for (const item of included) {
    if (item.type === 'pdf') {
      const srcDoc = await PDFDocument.load(item.data);
      // Pages read before per-page settings existed: take them all, as they are.
      const pages = Array.isArray(item.pages)
        ? item.pages.map((p, k) => ({ ...p, index: p.src != null ? p.src : k })) // src: page number in the file; array order = stitch order
        : srcDoc.getPageIndices().map((index) => ({ index, include: true, size: 'original', rot: 0 }));
      const keep = pages.filter((p) => p.include);
      // Untouched size: copy the page itself (lossless), only its rotation changes.
      const asIs = keep.filter((p) => !p.size || p.size === 'original').map((p) => p.index);
      const copied = asIs.length ? await outDoc.copyPages(srcDoc, asIs) : [];
      for (const p of keep) {
        const src = srcDoc.getPage(p.index);
        const r = norm((src.getRotation().angle || 0) + (p.rot || 0));
        if (!p.size || p.size === 'original') {
          const page = copied[asIs.indexOf(p.index)];
          page.setRotation(degrees(r));
          outDoc.addPage(page);
        } else {
          // New paper: the page goes in as a vector form, scaled to fit.
          const cb = src.getCropBox();
          const emb = await outDoc.embedPage(src, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
          const at = placeOnPaper(cb.width, cb.height, r, p.size);
          const page = outDoc.addPage([at.paperW, at.paperH]);
          page.drawPage(emb, { x: at.x, y: at.y, width: at.width, height: at.height, rotate: degrees(at.rotate) });
        }
      }
    } else if (item.type === 'image') {
      const img = item.imageType === 'jpg' ? await outDoc.embedJpg(item.data) : await outDoc.embedPng(item.data);
      const at = placeOnPaper(img.width, img.height, norm(item.rot || 0), item.size || item.pageSize, 0.92);
      const page = outDoc.addPage([at.paperW, at.paperH]);
      page.drawImage(img, { x: at.x, y: at.y, width: at.width, height: at.height, rotate: degrees(at.rotate) });
    } else {
      const dims = getDims(item.size || item.pageSize, item.rot != null ? (norm(item.rot) % 180 ? 'landscape' : 'portrait') : item.orientation);
      const margin = 54;
      const fontSize = 12;
      const lineHeight = fontSize * 1.4;
      const maxWidth = dims.width - margin * 2;
      const lines = wrapText(item.content, font, fontSize, maxWidth);
      let page = outDoc.addPage([dims.width, dims.height]);
      let y = dims.height - margin;
      for (const line of lines) {
        if (y < margin) {
          page = outDoc.addPage([dims.width, dims.height]);
          y = dims.height - margin;
        }
        page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.11, 0.12, 0.13) });
        y -= lineHeight;
      }
    }
  }

  return outDoc.save();
}

export async function generatePDF(items, filename) {
  downloadBytes(await buildPDF(items), filename);
}
