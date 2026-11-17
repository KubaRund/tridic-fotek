import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { copyPhotos, scanPhotos } from "../disk.js";
import { captureDate, filenameDate } from "../exif.js";
import { planPhotos, shouldCopy } from "../planner.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../tridic.js", import.meta.url));
const photo = (relative, data, options = {}) => ({ relative, file: new File([data], relative.split("/").at(-1), options) });

// Test metadata containing a date and no pixel data.
function tiffDate(yearMonthDay) {
  const data = Buffer.alloc(64);
  data.write("II");
  data.writeUInt16LE(42, 2);
  data.writeUInt32LE(8, 4);
  data.writeUInt16LE(1, 8);
  data.writeUInt16LE(0x8769, 10);
  data.writeUInt16LE(4, 12);
  data.writeUInt32LE(1, 14);
  data.writeUInt32LE(26, 18);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(0x9003, 28);
  data.writeUInt16LE(2, 30);
  data.writeUInt32LE(20, 32);
  data.writeUInt32LE(44, 36);
  data.write(`${yearMonthDay} 12:34:56\0`, 44, "ascii");
  return data;
}

function metadataJpeg(date) {
  const segment = Buffer.concat([Buffer.from("Exif\0\0"), tiffDate(date)]);
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(segment.length + 2, 4);
  return Buffer.concat([header, segment, Buffer.from([0xff, 0xd9])]);
}

test("reads JPEG, TIFF, PNG and WebP metadata and checks calendar dates", async () => {
  const date = "2024-08-14";
  const tiff = tiffDate("2024:08:14");
  const pngLength = Buffer.alloc(4);
  pngLength.writeUInt32BE(tiff.length);
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngLength, Buffer.from("eXIf"), tiff, Buffer.alloc(4)]);
  const webpLength = Buffer.alloc(4);
  webpLength.writeUInt32LE(tiff.length);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPEXIF"), webpLength, tiff]);
  for (const [name, input] of [["a.jpg", metadataJpeg("2024:08:14")], ["b.tif", tiff], ["c.png", png], ["d.webp", webp]]) {
    assert.equal(await captureDate(photo(name, input).file), date);
  }
  assert.equal(filenameDate("IMG_20250202_114315.jpg"), "2025-02-02");
  assert.equal(filenameDate("20240229010101_A.jpg"), "2024-02-29");
  assert.equal(filenameDate("IMG_20250229.jpg"), null);
});

test("marks byte-identical photos under different names and reserves existing suffixes", async () => {
  const first = metadataJpeg("2024:08:14");
  const second = metadataJpeg("2024:08:22");
  const { rows, ignored } = await planPhotos([
    photo("A/foto.jpg", first), photo("B/FOTO.JPG", second), photo("C/foto (2).jpg", first),
    photo("D/jiné-jméno.jpg", first), photo("E/notes.txt", "irrelevant"),
  ]);
  assert.equal(ignored, 1);
  assert.equal(rows[1].target, "2024/08/FOTO (3).JPG");
  assert.equal(rows[1].duplicateOf, null);
  assert.equal(rows[3].duplicateOf, "A/foto.jpg");
  assert.equal(rows.filter((row) => shouldCopy(row, false)).length, 2);
  assert.equal(rows.filter((row) => shouldCopy(row, true)).length, 4);
});

test("compares the entire file before marking a duplicate", async () => {
  const first = new Uint8Array(32_000);
  const middleChanged = first.slice();
  middleChanged[16_000] = 17;
  const { rows } = await planPhotos([
    photo("A/1.jpg", first), photo("B/2.jpg", middleChanged), photo("C/3.jpg", middleChanged),
  ]);
  assert.equal(rows[1].duplicateOf, null);
  assert.equal(rows[2].duplicateOf, "B/2.jpg");
});

test("keeps the identical file with stronger date evidence", async () => {
  const bytes = Buffer.from("synthetic file data with no EXIF");
  const { rows } = await planPhotos([
    photo("A/foto.jpg", bytes, { lastModified: new Date(2022, 0, 1, 12).getTime() }),
    photo("B/IMG_20240812.jpg", bytes),
  ], { useModified: true });
  assert.equal(rows[0].duplicateOf, "B/IMG_20240812.jpg");
  assert.equal(rows[1].target, "2024/08/IMG_20240812.jpg");
  assert.equal(rows[1].duplicateOf, null);
});

test("a failed comparison flags the affected file and keeps the readable entries", async () => {
  const bytes = Buffer.alloc(32_000);
  const damaged = photo("A/a.jpg", bytes);
  const slice = damaged.file.slice.bind(damaged.file);
  damaged.file.slice = (start, end) => {
    if (start === 0 && end === bytes.length) throw Error("synthetic read failure");
    return slice(start, end);
  };
  const { rows } = await planPhotos([damaged, photo("B/b.jpg", bytes), photo("C/c.jpg", bytes)]);
  assert.equal(rows[0].readError, true);
  assert.equal(rows[1].readError, false);
  assert.equal(rows[1].duplicateOf, null);
  assert.equal(rows[2].duplicateOf, "B/b.jpg");
});

test("uses the modification time only when requested", async () => {
  const row = photo("A/sken.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), { lastModified: new Date(2023, 4, 1, 12).getTime() });
  assert.equal((await planPhotos([row])).rows[0].target, "Bez data/sken.png");
  const { rows } = await planPhotos([row], { useModified: true });
  assert.equal(rows[0].target, "2023/05/sken.png");
  assert.equal(rows[0].source, "Změna souboru");
});

async function testDirectory(t) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "tridic-fotek-test-"));
  assert.equal(dirname(root), temp);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("the CLI reports groups and writes byte-identical copies with original times", async (t) => {
  const root = await testDirectory(t);
  const source = join(root, "vstup");
  const destination = join(root, "vystup");
  const one = metadataJpeg("2024:08:14");
  const two = metadataJpeg("2024:08:22");
  await mkdir(join(source, "A"), { recursive: true });
  await mkdir(join(source, "B"), { recursive: true });
  await mkdir(destination);
  const original = join(source, "A", "foto.jpg");
  const accessed = Date.UTC(2024, 8, 1) / 1000;
  const modified = Date.UTC(2024, 7, 14, 12, 34, 56) / 1000;
  await writeFile(original, one);
  await utimes(original, accessed, modified);
  await writeFile(join(source, "B", "foto.jpg"), two);
  await writeFile(join(source, "B", "kopie.jpg"), one);
  await writeFile(join(source, "poznamky.txt"), "plain text");

  const preview = await run(process.execPath, [cli, source]);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.vynechaneFormaty, 1);
  assert.equal(plan.soubory.length, 3);
  assert.equal(plan.soubory[2].kopirovat, false);
  assert.deepEqual(await readdir(destination), []);
  const csv = await run(process.execPath, [cli, source, "--csv"]);
  assert.match(csv.stdout, /^\uFEFF"Zdroj";"Datum"/);
  assert.match(csv.stdout, /"B\/kopie\.jpg"[^\n]*;"Ne";/);
  const summary = await run(process.execPath, [cli, source, "--prehled"]);
  assert.match(summary.stdout, /Nalezeno: 3 · Ke kopírování: 2 · Shodné: 1/);
  assert.match(summary.stdout, /2024\/08  2/);
  const withDuplicates = await run(process.execPath, [cli, source, "--prehled", "--vcetne-shodnych"]);
  assert.match(withDuplicates.stdout, /2024\/08  3/);
  await assert.rejects(run(process.execPath, [cli, source, "--prehled", "--csv"]), /jen jeden výstup/);

  await assert.rejects(run(process.execPath, [cli, source, "--kopirovat", join(source, "A")]), /mimo zdrojovou/);
  // Reset access time after reading the source during the previews above.
  await utimes(original, accessed, modified);
  await run(process.execPath, [cli, source, "--kopirovat", destination]);
  const [output] = await readdir(destination);
  const month = join(destination, output, "2024", "08");
  assert.deepEqual((await readdir(month)).sort(), ["foto (2).jpg", "foto.jpg"]);
  const times = await stat(join(month, "foto.jpg"));
  assert.ok(Math.abs(times.atimeMs - accessed * 1000) < 2);
  assert.ok(Math.abs(times.mtimeMs - modified * 1000) < 2);
  assert.deepEqual(await readFile(join(month, "foto.jpg")), one);
  assert.deepEqual(await readFile(join(month, "foto (2).jpg")), two);
  assert.deepEqual(await readFile(join(source, "A", "foto.jpg")), one);
  assert.deepEqual(await readFile(join(source, "B", "kopie.jpg")), one);
});

test("uses a verified duplicate when the planned source disappears during copying", async (t) => {
  const root = await testDirectory(t);
  const source = join(root, "vstup");
  const destination = join(root, "vystup");
  await mkdir(source);
  await mkdir(destination);
  const original = join(source, "IMG_20240812.jpg");
  const backup = join(source, "kopie.jpg");
  const data = Buffer.alloc(150_000, 34);
  await writeFile(original, data);
  await writeFile(backup, data);
  const scanned = await scanPhotos(source);
  const { rows } = await planPhotos(scanned.entries);

  await unlink(original);
  const result = await copyPhotos(source, destination, rows);
  assert.equal(result.copied, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /shodná kopie kopie\.jpg/);
  assert.deepEqual(await readFile(join(result.folder, "2024", "08", "IMG_20240812.jpg")), data);

  await unlink(backup);
  const failed = await copyPhotos(source, destination, rows);
  assert.equal(failed.copied, 0);
  assert.equal(failed.errors.length, 1);
  assert.deepEqual(await readdir(join(failed.folder, "2024", "08")), []);
});
