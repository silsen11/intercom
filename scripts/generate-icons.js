/**
 * Generador de iconos PWA para RiderCom Mesh Pro
 * Crea icon-192.png, icon-512.png y icon.svg sin dependencias externas
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// 1. Crear icono SVG vectorial de alta calidad
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="bgGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#1e293b"/>
      <stop offset="100%" stop-color="#080c14"/>
    </radialGradient>
    <linearGradient id="neonCyan" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
    <linearGradient id="neonAmber" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#d97706"/>
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#0284c7" flood-opacity="0.6"/>
    </filter>
  </defs>

  <!-- Fondo squircle oscuro de app Android -->
  <rect width="512" height="512" rx="110" fill="url(#bgGrad)"/>
  <rect x="12" y="12" width="488" height="488" rx="100" fill="none" stroke="url(#neonCyan)" stroke-width="6" opacity="0.4"/>

  <!-- Anillos concéntricos de transmisión Mesh (Radiofrecuencia) -->
  <circle cx="256" cy="256" r="190" fill="none" stroke="#38bdf8" stroke-width="4" stroke-dasharray="16 12" opacity="0.3"/>
  <circle cx="256" cy="256" r="140" fill="none" stroke="#f59e0b" stroke-width="4" stroke-dasharray="12 10" opacity="0.4"/>

  <!-- Símbolo de Casco de Moto con Visor Neón -->
  <g filter="url(#glow)">
    <!-- Silueta exterior del casco -->
    <path d="M 256 90 C 160 90 110 160 110 240 C 110 320 130 380 200 400 L 220 400 L 230 380 L 300 380 L 310 400 L 340 395 C 390 370 402 310 402 240 C 402 160 352 90 256 90 Z" fill="#0f172a" stroke="url(#neonCyan)" stroke-width="12"/>

    <!-- Visor de casco deportivo (Tintado reflectivo) -->
    <path d="M 180 210 C 230 185 290 185 340 210 C 365 222 365 270 330 275 C 280 282 240 282 190 275 C 155 270 155 222 180 210 Z" fill="url(#neonCyan)" opacity="0.9"/>

    <!-- Reflejo en visor -->
    <path d="M 195 220 C 235 200 280 200 320 220" fill="none" stroke="#ffffff" stroke-width="5" stroke-linecap="round" opacity="0.7"/>

    <!-- Micrófono Intercomunicador de Casco (Brazo con esponja) -->
    <path d="M 170 330 Q 140 360 210 365" fill="none" stroke="#64748b" stroke-width="10" stroke-linecap="round"/>
    <rect x="205" y="352" width="34" height="24" rx="12" fill="url(#neonAmber)"/>

    <!-- Ondas de transmisión de voz -->
    <path d="M 250 364 Q 265 364 275 354" fill="none" stroke="#10b981" stroke-width="5" stroke-linecap="round"/>
    <path d="M 250 364 Q 275 364 290 348" fill="none" stroke="#10b981" stroke-width="4" stroke-linecap="round" opacity="0.7"/>
  </g>
</svg>`;

const publicDir = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(publicDir, 'icon.svg'), svgContent, 'utf8');
console.log('✓ icon.svg generado exitosamente');

// 2. Generador PNG binario puro
function generatePng(size) {
  const width = size;
  const height = size;
  const bytesPerPixel = 4;
  const scanlineLength = width * bytesPerPixel + 1;
  const buffer = Buffer.alloc(scanlineLength * height);

  const cx = width / 2;
  const cy = height / 2;
  const rOuter = width * 0.44;
  const rHelmet = width * 0.28;

  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLength;
    buffer[rowOffset] = 0; // Filter: none

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * bytesPerPixel;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      let r = 8, g = 12, b = 20, a = 255; // Fondo azul oscuro #080c14

      // Squircle background
      const cornDist = Math.pow(Math.abs(dx) / (width * 0.45), 4) + Math.pow(Math.abs(dy) / (height * 0.45), 4);
      if (cornDist > 1.05) {
        a = 0; // Fuera del squircle (transparente)
      } else if (cornDist > 0.96) {
        // Borde squircle cian
        r = 56; g = 189; b = 248; a = 255;
      } else if (dist > rOuter - 6 && dist < rOuter + 2) {
        // Anillo de radiofrecuencia exterior
        r = 56; g = 189; b = 248; a = 180;
      } else if (dist < rHelmet) {
        // Casco de moto central
        if (dy > -rHelmet * 0.1 && dy < rHelmet * 0.45 && Math.abs(dx) < rHelmet * 0.75) {
          // Visor cian brillante
          r = 56; g = 189; b = 248; a = 255;
        } else if (dy >= rHelmet * 0.45 && dy <= rHelmet * 0.75 && dx > -rHelmet * 0.3 && dx < rHelmet * 0.4) {
          // Esponja de micrófono ámbar
          r = 245; g = 158; b = 11; a = 255;
        } else {
          // Cuerpo del casco azul pizarra oscuro
          r = 30; g = 41; b = 59; a = 255;
        }
      }

      buffer[pxOffset] = r;
      buffer[pxOffset + 1] = g;
      buffer[pxOffset + 2] = b;
      buffer[pxOffset + 3] = a;
    }
  }

  const compressed = zlib.deflateSync(buffer);

  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) {
        c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData), 0);
    return Buffer.concat([len, typeAndData, crc]);
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

const png192 = generatePng(192);
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), png192);
console.log('✓ icon-192.png generado:', png192.length, 'bytes');

const png512 = generatePng(512);
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), png512);
console.log('✓ icon-512.png generado:', png512.length, 'bytes');
