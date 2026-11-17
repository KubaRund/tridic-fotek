import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { captureDate, filenameDate, modifiedDate } from "./exif.js";

const extensions = new Set(["jpg", "jpeg", "png", "webp", "tif", "tiff", "cr2", "cr3", "heic", "heif", "avif", "dng", "nef", "arw", "raf", "gif", "bmp"]);
const key = (name) => name.normalize("NFC").toLowerCase();
const compare = new Intl.Collator("cs-CZ", { numeric: true });
const datePriority = { EXIF: 0, "Název": 1, "Změna souboru": 2, "Bez data": 3 };

function comparePaths(a, b) {
  const order = compare.compare(a.relative, b.relative);
  if (order || a.relative === b.relative) return order;
  return a.relative < b.relative ? -1 : 1;
}

export function isPhotoName(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && extensions.has(name.slice(dot + 1).toLowerCase());
}

function fileParts(name) {
  const dot = name.lastIndexOf(".");
  return [name.slice(0, dot), name.slice(dot)];
}

function safeName(name) {
  const [stem, extension] = fileParts(name.normalize("NFC"));
  const cleaned = stem.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "");
  const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
  const base = reserved.test(cleaned) ? `_${cleaned}` : cleaned || "fotka";
  return `${Array.from(base).slice(0, 90).join("")}${extension}`;
}

function groupBy(rows, selector) {
  const groups = new Map();
  for (const row of rows) {
    const value = selector(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

async function readBytes(row, from, to = row.file.size) {
  const end = Math.min(to, row.file.size);
  try {
    const bytes = Buffer.from(await row.file.slice(from, end).arrayBuffer());
    if (bytes.length === end - from) return bytes;
  } catch {
    // A file can become inaccessible while its contents are being checked.
  }
  row.readError = true;
  return null;
}

async function signature(row) {
  const edge = 8192;
  const size = row.file.size;
  const head = await readBytes(row, 0, edge);
  if (!head) return null;
  const hash = createHash("sha256").update(head);
  if (size > edge) {
    const tail = await readBytes(row, Math.max(edge, size - edge));
    if (!tail) return null;
    hash.update(tail);
  }
  return hash.digest("hex");
}

async function identical(a, b) {
  const block = 1024 * 1024;
  for (let offset = 0; offset < a.file.size; offset += block) {
    const [left, right] = await Promise.all([readBytes(a, offset, offset + block), readBytes(b, offset, offset + block)]);
    if (!left || !right || !left.equals(right)) return false;
  }
  return true;
}

async function markDuplicates(rows, progress) {
  const candidates = [...groupBy(rows, (row) => row.file.size).values()].filter((group) => group.length > 1);
  const total = candidates.reduce((sum, group) => sum + group.length, 0);
  let done = 0;
  for (const group of candidates) {
    group.sort((a, b) => datePriority[a.source] - datePriority[b.source]);
    const representatives = new Map();
    for (const row of group) {
      progress("duplicates", done++, total);
      const hash = await signature(row);
      if (hash === null) continue;
      const possible = representatives.get(hash) ?? [];
      for (const original of possible) {
        if (original.readError) continue;
        if (await identical(original, row)) {
          row.duplicateOf = original.relative;
          break;
        }
        if (row.readError) break;
      }
      if (!row.duplicateOf && !row.readError) {
        possible.push(row);
        representatives.set(hash, possible);
      }
    }
  }
}

function assignPaths(rows) {
  const originalPaths = new Set(rows.map((row) => key(`${row.folder}/${row.name}`)));
  const assigned = new Set();
  const inCopyOrder = [...rows.filter((row) => !row.duplicateOf), ...rows.filter((row) => row.duplicateOf)];
  for (const row of inCopyOrder) {
    const [stem, extension] = fileParts(row.name);
    let filename = row.name;
    let number = 2;
    let target = `${row.folder}/${filename}`;
    if (assigned.has(key(target))) {
      do {
        filename = `${stem} (${number++})${extension}`;
        target = `${row.folder}/${filename}`;
      } while (assigned.has(key(target)) || originalPaths.has(key(target)));
    }
    assigned.add(key(target));
    row.target = target;
    row.targetName = filename;
    row.renamed = filename !== row.file.name;
  }
}

export async function planPhotos(entries, { useModified = false, progress = () => {} } = {}) {
  const selected = entries.filter(({ file }) => isPhotoName(file.name));
  selected.sort(comparePaths);
  const rows = [];
  for (const [index, { file, relative }] of selected.entries()) {
    progress("metadata", index, selected.length);
    let date;
    let readError = false;
    try {
      date = await captureDate(file);
    } catch {
      readError = true;
    }
    const fromName = date ? null : filenameDate(file.name);
    const fromModified = !date && !fromName && useModified ? modifiedDate(file.lastModified) : null;
    const source = date ? "EXIF" : fromName ? "Název" : fromModified ? "Změna souboru" : "Bez data";
    date = date ?? fromName ?? fromModified;
    const folder = date ? date.slice(0, 7).replace("-", "/") : "Bez data";
    rows.push({ file, relative, name: safeName(file.name), date, source, folder, readError, duplicateOf: null });
  }
  await markDuplicates(rows, progress);
  assignPaths(rows);
  return { rows, ignored: entries.length - selected.length };
}

export function shouldCopy(row, includeDuplicates = false) {
  return !row.duplicateOf || includeDuplicates;
}
