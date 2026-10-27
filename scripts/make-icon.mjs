// Builds assets/mai.ico from the default sprite's idle frame (an ICO can hold PNG data directly).
import { readFileSync, writeFileSync } from "node:fs";
const png = readFileSync(new URL("../sprites/aza/idle/idle.png", import.meta.url));
const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
const head = Buffer.alloc(6 + 16);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
head.writeUInt8(w >= 256 ? 0 : w, 6); head.writeUInt8(h >= 256 ? 0 : h, 7);
head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
head.writeUInt32LE(png.length, 14); head.writeUInt32LE(22, 18);
writeFileSync(new URL("../assets/mai.ico", import.meta.url), Buffer.concat([head, png]));
console.log(`assets/mai.ico (${w}x${h})`);
