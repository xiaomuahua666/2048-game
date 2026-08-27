// One-shot generator for favicon assets. Zero dependencies: encodes PNG
// directly with node:zlib. Outputs are committed; rerun only to change art.
import { writeFile } from "node:fs/promises";
import zlib from "node:zlib";

function crc32(buffer) {
    if (!crc32.table) {
        crc32.table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            crc32.table[n] = c >>> 0;
        }
    }
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crc32.table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
    const stride = size * 4 + 1;
    const raw = Buffer.alloc(size * stride);
    for (let y = 0; y < size; y++) {
        rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

// 5x7 pixel digit font, enough for "2048".
const FONT = {
    0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    2: ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
    4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
};

const BACKGROUND = [0xed, 0xc2, 0x2e, 255]; // 2048-tile yellow
const FOREGROUND = [0xf9, 0xf6, 0xf2, 255]; // tile text off-white

function insideRoundedRect(x, y, size, radius) {
    const px = x + 0.5;
    const py = y + 0.5;
    const nearX = Math.min(Math.max(px, radius), size - radius);
    const nearY = Math.min(Math.max(py, radius), size - radius);
    return (px - nearX) ** 2 + (py - nearY) ** 2 <= radius ** 2;
}

function renderIcon(size, radius, fontScale, gap) {
    const rgba = Buffer.alloc(size * size * 4);
    const putPixel = (x, y, [r, g, b, a]) => {
        const offset = (y * size + x) * 4;
        rgba[offset] = r;
        rgba[offset + 1] = g;
        rgba[offset + 2] = b;
        rgba[offset + 3] = a;
    };

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (insideRoundedRect(x, y, size, radius)) putPixel(x, y, BACKGROUND);
        }
    }

    const digits = [2, 0, 4, 8];
    const digitWidth = 5 * fontScale;
    const totalWidth = digits.length * digitWidth + (digits.length - 1) * gap;
    let cursorX = Math.round((size - totalWidth) / 2);
    const cursorY = Math.round((size - 7 * fontScale) / 2);
    for (const digit of digits) {
        const glyph = FONT[digit];
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
                if (glyph[row][col] !== "1") continue;
                for (let dy = 0; dy < fontScale; dy++) {
                    for (let dx = 0; dx < fontScale; dx++) {
                        putPixel(cursorX + col * fontScale + dx, cursorY + row * fontScale + dy, FOREGROUND);
                    }
                }
            }
        }
        cursorX += digitWidth + gap;
    }
    return encodePng(size, rgba);
}

const root = new URL("../", import.meta.url);
await writeFile(new URL("src/favicon.png", root), renderIcon(64, 12, 2, 4));
await writeFile(new URL("src/apple-touch-icon.png", root), renderIcon(180, 32, 6, 8));
await writeFile(new URL("src/favicon.svg", root),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    + '<rect width="64" height="64" rx="12" fill="#edc22e"/>'
    + '<text x="32" y="40" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="bold" '
    + 'fill="#f9f6f2" text-anchor="middle" dominant-baseline="middle">2048</text>'
    + "</svg>\n");
console.log("wrote src/favicon.png, src/apple-touch-icon.png, src/favicon.svg");
