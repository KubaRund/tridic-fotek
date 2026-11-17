const ascii = (bytes) => new TextDecoder().decode(bytes).split("\0")[0];

export function validDate(year, month, day) {
  const date = new Date(Date.UTC(+year, +month - 1, +day));
  if (+year < 1900 || date.getUTCFullYear() !== +year || date.getUTCMonth() + 1 !== +month
      || date.getUTCDate() !== +day) return null;
  return `${year}-${month}-${day}`;
}

function fromTimestamp(text) {
  const match = text?.match(/^(\d{4}):(\d{2}):(\d{2})\s+\d{2}:\d{2}:\d{2}/);
  return match ? validDate(...match.slice(1)) : null;
}

function segmentReader(file, start = 0, end = file.size) {
  return async (offset, length) => {
    if (offset < 0 || length < 0 || offset + length > end - start) return null;
    return new DataView(await file.slice(start + offset, start + offset + length).arrayBuffer());
  };
}

async function tiffDate(read) {
  const header = await read(0, 8);
  const endian = header?.getUint16(0);
  if (endian !== 0x4949 && endian !== 0x4d4d) return null;
  const little = endian === 0x4949;
  if (header.getUint16(2, little) !== 42) return null;

  async function entries(at) {
    if (at < 8) return null;
    const count = (await read(at, 2))?.getUint16(0, little);
    return count && count <= 4096 ? read(at + 2, count * 12) : null;
  }

  function find(directory, tag) {
    for (let offset = 0; directory && offset < directory.byteLength; offset += 12) {
      if (directory.getUint16(offset, little) === tag) {
        return new DataView(directory.buffer, directory.byteOffset + offset, 12);
      }
    }
    return null;
  }

  const primary = await entries(header.getUint32(4, little));
  const pointer = find(primary, 0x8769);
  if (!pointer || pointer.getUint16(2, little) !== 4 || pointer.getUint32(4, little) !== 1) return null;
  const exif = await entries(pointer.getUint32(8, little));
  const stamp = find(exif, 0x9003);
  if (!stamp || stamp.getUint16(2, little) !== 2) return null;
  const length = stamp.getUint32(4, little);
  if (length < 19 || length > 128) return null;
  const value = await read(stamp.getUint32(8, little), length);
  return value ? fromTimestamp(ascii(value)) : null;
}

async function jpegDate(file, read) {
  for (let offset = 2; offset + 4 <= file.size;) {
    const header = await read(offset, 4);
    if (header.getUint8(0) !== 0xff) return null;
    const marker = header.getUint8(1);
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const size = header.getUint16(2);
    const end = offset + 2 + size;
    if (size < 2 || end > file.size) return null;
    if (marker === 0xe1 && size >= 16 && ascii(await read(offset + 4, 6)) === "Exif") {
      const capture = await tiffDate(segmentReader(file, offset + 10, end));
      if (capture) return capture;
    }
    offset = end;
  }
  return null;
}

async function chunkDate(file, read, offset, webp) {
  for (; offset + 8 <= file.size;) {
    const header = await read(offset, 8);
    const size = header.getUint32(webp ? 4 : 0, webp);
    const label = ascii(new DataView(header.buffer, webp ? 0 : 4, 4));
    const start = offset + 8;
    const end = start + size;
    if (end > file.size) return null;
    if (label === (webp ? "EXIF" : "eXIf")) {
      const prefix = size >= 6 && ascii(await read(start, 6)) === "Exif" ? 6 : 0;
      return tiffDate(segmentReader(file, start + prefix, end));
    }
    if (label === "IEND") return null;
    offset = end + (webp ? size % 2 : 4);
  }
  return null;
}

export async function captureDate(file) {
  const read = segmentReader(file);
  const header = await read(0, 12);
  if (!header) return null;
  const magic = header.getUint16(0);
  if (magic === 0xffd8) return jpegDate(file, read);
  if (magic === 0x4949 || magic === 0x4d4d) return tiffDate(read);
  if (header.getUint32(0) === 0x89504e47 && header.getUint32(4) === 0x0d0a1a0a) {
    return chunkDate(file, read, 8, false);
  }
  if (header.getUint32(0) === 0x52494646 && header.getUint32(8) === 0x57454250) {
    return chunkDate(file, read, 12, true);
  }
  return null;
}

export function filenameDate(filename) {
  const match = filename.match(/^(?:(?:IMG|DSC|PXL|MVIMG|Screenshot)[-_ ]+)?(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?=[ ._-]|\d{6}(?:[ ._-]|$)|$)/i);
  return match ? validDate(...match.slice(1)) : null;
}

export function modifiedDate(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || timestamp <= 0) return null;
  return validDate(String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
}
