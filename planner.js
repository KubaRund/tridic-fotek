import { captureDate, filenameDate, modifiedDate } from "./exif.js";

const extensions = new Set(["jpg", "jpeg", "png", "webp", "tif", "tiff", "cr2", "cr3", "heic", "heif", "avif", "dng", "nef", "arw", "raf", "gif", "bmp"]);
const key = (name) => name.normalize("NFC").toLowerCase();
const compare = new Intl.Collator("cs-CZ", { numeric: true });

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

const bytes = async (file, from, to) => new Uint8Array(await file.slice(from, to).arrayBuffer());

async function signature(file) {
  const edge = 8192;
  const head = await bytes(file, 0, edge);
  const tail = file.size > edge ? await bytes(file, Math.max(edge, file.size - edge)) : new Uint8Array();
  const sample = new Uint8Array(head.length + tail.length);
  sample.set(head);
  sample.set(tail, head.length);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", sample));
  return Array.from(digest, (n) => n.toString(16).padStart(2, "0")).join("");
}

async function identical(a, b) {
  if (a.size !== b.size) return false;
  const block = 1024 * 1024;
  for (let offset = 0; offset < a.size; offset += block) {
    const [left, right] = await Promise.all([bytes(a, offset, offset + block), bytes(b, offset, offset + block)]);
    if (left.length !== right.length || left.some((value, index) => value !== right[index])) return false;
  }
  return true;
}

async function markDuplicates(rows, progress) {
  const candidates = [...groupBy(rows, (row) => row.file.size).values()].filter((group) => group.length > 1);
  const total = candidates.reduce((sum, group) => sum + group.length, 0);
  let done = 0;
  for (const group of candidates) {
    const representatives = new Map();
    for (const row of group) {
      progress("duplicates", done++, total);
      try {
        const hash = await signature(row.file);
        const possible = representatives.get(hash) ?? [];
        for (const original of possible) {
          if (await identical(original.file, row.file)) {
            row.duplicateOf = original.relative;
            break;
          }
        }
        if (!row.duplicateOf) {
          possible.push(row);
          representatives.set(hash, possible);
        }
      } catch {
        row.readError = true;
      }
    }
  }
}

function assignPaths(rows) {
  const originalPaths = new Set(rows.map((row) => key(`${row.folder}/${row.name}`)));
  const assigned = new Set();
  for (const row of rows) {
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
  selected.sort((a, b) => compare.compare(a.relative, b.relative) || (a.relative < b.relative ? -1 : Number(a.relative !== b.relative)));
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
