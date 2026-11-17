'use strict';
// Generate the PWA icons without any image library. Pure Node + zlib.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const GLYPH = [
  '01111',
  '11000',
  '11000',
  '01110',
  '00011',
  '00011',
  '11110',
];

function make(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.22;
  const scale = Math.floor(size / 12);
  const gw = 5 * scale;
  const gh = 7 * scale;
  const gx = Math.floor((size - gw) / 2);
  const gy = Math.floor((size - gh) / 2) - (size > 256 ? 5 : 0);

  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = Math.min(Math.max(Math.abs(x - cx) - (cx - radius), 0), radius);
      const dy = Math.min(Math.max(Math.abs(y - cy) - (cy - radius), 0), radius);
      const outside = Math.hypot(dx, dy) > radius ? Math.hypot(dx, dy) - radius : 0;

      const gxCell = Math.floor((x - gx) / scale);
      const gyCell = Math.floor((y - gy) / scale);
      const isLetter = gxCell >= 0 && gxCell < 5 && gyCell >= 0 && gyCell < 7 && GLYPH[gyCell][gxCell] === '1';

      const i = row + 1 + x * 4;
      if (outside >= 1 || x < 0 || y < 0) {
        raw[i] = raw[i + 1] = raw[i + 2] = raw[i + 3] = 0;
        continue;
      }
      if (isLetter) {
        raw[i] = 255; raw[i + 1] = 255; raw[i + 2] = 255; raw[i + 3] = 255;
        continue;
      }
      const t = Math.min(1, Math.hypot(x - cx, y + cy) / (size * 1.45));
      raw[i] = Math.round(110 + (167 - 110) * t);       // R
      raw[i + 1] = Math.round(168 + (139 - 168) * t);   // G
      raw[i + 2] = Math.round(254 + (250 - 254) * t);   // B
      raw[i + 3] = outside > 0 ? Math.round(255 * (1 - outside)) : 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'frontend', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(out, `icon-${size}.png`);
  fs.writeFileSync(file, make(size));
  console.log(`${file} (${fs.statSync(file).size} bytes)`);
}
