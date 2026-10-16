import { zlibSync } from 'fflate';

// Small bitmap alphabet avoids fonts, canvas, external images and image services.
const glyphs: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
};
function chunk(name: string, data: Uint8Array) {
  const output = new Uint8Array(data.length + 12),
    view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(new TextEncoder().encode(name), 4);
  output.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(output.length - 4, (crc ^ 0xffffffff) >>> 0);
  return output;
}
export function probeImage(code: string): Uint8Array {
  if (!/^[0-9A-F]{6}$/.test(code)) throw new Error('Invalid image challenge');
  const scale = 5,
    padding = 12,
    width = padding * 2 + code.length * 6 * scale - scale,
    height = padding * 2 + 7 * scale;
  const pixels = new Uint8Array((width + 1) * height).fill(255);
  for (let y = 0; y < height; y++) pixels[y * (width + 1)] = 0;
  for (let i = 0; i < code.length; i++)
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 5; x++) {
        if (glyphs[code[i]][y][x] !== '1') continue;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++)
            pixels[
              (padding + y * scale + dy) * (width + 1) +
                1 +
                padding +
                i * 6 * scale +
                x * scale +
                dx
            ] = 0;
      }
  const header = new Uint8Array(13),
    view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(pixels)),
    chunk('IEND', new Uint8Array()),
  ];
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
