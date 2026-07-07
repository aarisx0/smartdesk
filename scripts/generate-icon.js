/**
 * generate-icon.js
 * Creates a minimal valid .ico file for SmartDesk AI
 * Uses raw BMP/ICO format - no external dependencies needed.
 * Run: node scripts/generate-icon.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

// ─── ICO file builder ─────────────────────────────────────────────────────────
// We embed a 32x32 and a 16x16 BMP image into the .ico container.

const INDIGO  = [79,  70, 229, 255];   // #4F46E5
const VIOLET  = [124, 58, 237, 255];   // #7C3AED
const WHITE   = [255, 255, 255, 255];
const TRANSP  = [0,   0,   0,   0];
const BG      = [13,  13,  26,  0];    // body background (transparent in ico)

/**
 * Build a 32-bit ARGB BMP pixel array (size × size) for a folder+sparkle icon.
 * Returns a flat BGRA Buffer (BMP row order = bottom-up).
 */
function renderIcon(size) {
  // Create pixel grid [y][x] = [B,G,R,A]
  const px = (val) => [...val]; // clone
  const grid = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => px(TRANSP))
  );

  const s = size;

  // ── Draw rounded rectangle background (indigo→violet gradient) ──
  const r = Math.round(s * 0.18); // corner radius
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      // Simple gradient: lerp between INDIGO and VIOLET left-to-right + top-to-bottom
      const t = (x + y) / (2 * s);
      const col = INDIGO.map((c, i) => Math.round(c + t * (VIOLET[i] - c)));
      col[3] = 255;

      // Rounded corner test
      const inBounds = x >= r && x < s - r && y >= r && y < s - r;
      const tlCorner = x < r     && y < r     && dist(x, y, r, r)         < r;
      const trCorner = x >= s-r  && y < r     && dist(x, y, s-r-1, r)     < r;
      const blCorner = x < r     && y >= s-r  && dist(x, y, r, s-r-1)     < r;
      const brCorner = x >= s-r  && y >= s-r  && dist(x, y, s-r-1, s-r-1) < r;

      if (inBounds || tlCorner || trCorner || blCorner || brCorner) {
        grid[y][x] = col;
      }
    }
  }

  // ── Draw folder outline (white, inner 60% of size) ──
  const fw = Math.round(s * 0.58);  // folder width
  const fh = Math.round(s * 0.44);  // folder body height
  const fx = Math.round((s - fw) / 2);
  const fy = Math.round(s * 0.30);
  const tabW = Math.round(fw * 0.36);
  const tabH = Math.round(s * 0.08);
  const lw = Math.max(1, Math.round(s / 16)); // line width

  // Folder tab
  rect(grid, fx, fy - tabH, tabW + fx, fy, WHITE, lw);
  // Folder body
  rect(grid, fx, fy, fx + fw, fy + fh, WHITE, lw);

  // ── Draw star/sparkle inside folder ──
  const cx = Math.round(s * 0.5);
  const cy = Math.round(fy + fh * 0.45);
  const sr = Math.round(s * 0.10);
  star(grid, cx, cy, sr, WHITE, lw);

  // ── Flatten to bottom-up BMP BGRA row array ──
  const pixels = [];
  for (let y = s - 1; y >= 0; y--) {  // BMP is bottom-up
    for (let x = 0; x < s; x++) {
      const [r2, g2, b2, a2] = grid[y][x];
      pixels.push(b2, g2, r2, a2); // BGRA
    }
  }
  return Buffer.from(pixels);
}

function dist(x1, y1, x2, y2) {
  return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2);
}

// Draw hollow rectangle outline
function rect(grid, x1, y1, x2, y2, color, lw) {
  const s = grid.length;
  for (let lk = 0; lk < lw; lk++) {
    for (let x = x1 + lk; x <= x2 - lk; x++) {
      setpx(grid, x, y1 + lk, color, s);
      setpx(grid, x, y2 - lk, color, s);
    }
    for (let y = y1 + lk; y <= y2 - lk; y++) {
      setpx(grid, x1 + lk, y, color, s);
      setpx(grid, x2 - lk, y, color, s);
    }
  }
}

// Draw 4-point diamond/star
function star(grid, cx, cy, r, color, lw) {
  const s = grid.length;
  // 4-point star: draw lines from center outward
  const pts = [
    [cx, cy - r],        // top
    [cx + r, cy],        // right
    [cx, cy + r],        // bottom
    [cx - r, cy],        // left
  ];
  for (const [tx, ty] of pts) {
    line(grid, cx, cy, tx, ty, color, lw, s);
  }
}

// Bresenham line
function line(grid, x1, y1, x2, y2, color, lw, size) {
  let dx = Math.abs(x2 - x1), sx = x1 < x2 ? 1 : -1;
  let dy = -Math.abs(y2 - y1), sy = y1 < y2 ? 1 : -1;
  let err = dx + dy;
  let cx = x1, cy = y1;
  while (true) {
    for (let k = -Math.floor(lw / 2); k <= Math.ceil(lw / 2); k++) {
      setpx(grid, cx + k, cy, color, size);
      setpx(grid, cx, cy + k, color, size);
    }
    if (cx === x2 && cy === y2) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; cx += sx; }
    if (e2 <= dx) { err += dx; cy += sy; }
  }
}

function setpx(grid, x, y, color, size) {
  if (x >= 0 && x < size && y >= 0 && y < size) grid[y][x] = [...color];
}

// ─── Build BMP DIB headers ─────────────────────────────────────────────────
function buildBMPData(size) {
  const pixelData = renderIcon(size);
  const w = size, h = size;

  // BITMAPINFOHEADER (40 bytes)
  const infoHeader = Buffer.alloc(40);
  infoHeader.writeUInt32LE(40, 0);           // biSize
  infoHeader.writeInt32LE(w, 4);             // biWidth
  infoHeader.writeInt32LE(h * 2, 8);         // biHeight (x2 for mask)
  infoHeader.writeUInt16LE(1, 12);           // biPlanes
  infoHeader.writeUInt16LE(32, 14);          // biBitCount (32-bit BGRA)
  infoHeader.writeUInt32LE(0, 16);           // biCompression (BI_RGB)
  infoHeader.writeUInt32LE(pixelData.length, 20); // biSizeImage
  infoHeader.writeInt32LE(0, 24);            // biXPelsPerMeter
  infoHeader.writeInt32LE(0, 28);            // biYPelsPerMeter
  infoHeader.writeUInt32LE(0, 32);           // biClrUsed
  infoHeader.writeUInt32LE(0, 36);           // biClrImportant

  // AND mask (all zeroes = fully visible, 1 bit per pixel, padded to 4 bytes)
  const maskRowBytes = Math.ceil(w / 8);
  const maskRowPadded = Math.ceil(maskRowBytes / 4) * 4;
  const andMask = Buffer.alloc(h * maskRowPadded, 0x00);

  return Buffer.concat([infoHeader, pixelData, andMask]);
}

// ─── ICO file assembler ────────────────────────────────────────────────────
function buildICO(sizes) {
  const images = sizes.map((sz) => buildBMPData(sz));

  // ICO header: 6 bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);         // reserved
  header.writeUInt16LE(1, 2);         // type: 1 = ICO
  header.writeUInt16LE(sizes.length, 4); // count

  // Each directory entry: 16 bytes
  const DIR_ENTRY_SIZE = 16;
  const dataOffset = 6 + sizes.length * DIR_ENTRY_SIZE;

  const dirs = [];
  let offset = dataOffset;
  for (let i = 0; i < sizes.length; i++) {
    const sz = sizes[i];
    const img = images[i];
    const entry = Buffer.alloc(DIR_ENTRY_SIZE);
    entry.writeUInt8(sz >= 256 ? 0 : sz, 0);   // width  (0 = 256)
    entry.writeUInt8(sz >= 256 ? 0 : sz, 1);   // height (0 = 256)
    entry.writeUInt8(0, 2);                      // color count (0 = >256)
    entry.writeUInt8(0, 3);                      // reserved
    entry.writeUInt16LE(1, 4);                   // planes
    entry.writeUInt16LE(32, 6);                  // bit count
    entry.writeUInt32LE(img.length, 8);          // bytes in image
    entry.writeUInt32LE(offset, 12);             // offset to image data
    dirs.push(entry);
    offset += img.length;
  }

  return Buffer.concat([header, ...dirs, ...images]);
}

// ─── Write files ──────────────────────────────────────────────────────────
const ico = buildICO([16, 32, 48, 256]);
const icoPath = path.join(ASSETS, 'icon.ico');
fs.writeFileSync(icoPath, ico);
console.log('✓ Created', icoPath, `(${ico.length} bytes)`);
console.log('✓ Icon ready for electron-builder');
