import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { captureDate, filenameDate } from "../dist/exif.js";
import { planPhotos, shouldCopy } from "../dist/planner.js";
import { copyPlan, planCsv } from "../dist/files.js";

const fixture = (name) => readFile(new URL(`../dist/ukazka/${name}.jpg`, import.meta.url));
const photo = (relative, content, options = {}) => ({ relative, file: new File([content], relative.split("/").at(-1), options) });

test("reads EXIF dates from real JPEG fixtures and validates filename dates", async () => {
  assert.equal(await captureDate(photo("lake.jpg", await fixture("jezero")).file), "2024-08-14");
  assert.equal(await captureDate(photo("forest.jpg", await fixture("les")).file), "2024-08-22");
  assert.equal(await captureDate(photo("desk.jpg", await fixture("stul")).file), null);
  assert.equal(filenameDate("IMG_20250202_114315.jpg"), "2025-02-02");
  assert.equal(filenameDate("20240229010101_A.jpg"), "2024-02-29");
  assert.equal(filenameDate("IMG_20250229.jpg"), null);
});

test("recognizes the date in TIFF and EXIF chunks wrapped by PNG and WebP", async () => {
  const jpeg = await fixture("jezero");
  const exif = jpeg.indexOf(Buffer.from("Exif\0\0"));
  const tiff = jpeg.subarray(exif + 6, exif - 2 + jpeg.readUInt16BE(exif - 2));
  const pngLength = Buffer.alloc(4);
  pngLength.writeUInt32BE(tiff.length);
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), pngLength, Buffer.from("eXIf"), tiff, Buffer.alloc(4)]);
  const webpLength = Buffer.alloc(4);
  webpLength.writeUInt32LE(tiff.length);
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPEXIF"), webpLength, tiff]);
  for (const [name, input] of [["a.tif", tiff], ["b.png", png], ["c.webp", webp]]) {
    assert.equal(await captureDate(photo(name, input).file), "2024-08-14");
  }
});

test("identical photos are marked even with different names; unequal contents need distinct routes", async () => {
  const lake = await fixture("jezero");
  const forest = await fixture("les");
  const { rows, ignored } = await planPhotos([
    photo("A/Hory.jpg", lake), photo("B/hory.JPG", forest), photo("C/Hory (2).jpg", lake),
    photo("D/jiné-jméno.jpg", lake), photo("E/notes.txt", "anything"),
  ]);
  assert.equal(ignored, 1);
  assert.equal(rows[1].target, "2024/08/hory (3).JPG");
  assert.equal(rows[1].duplicateOf, null);
  assert.equal(rows[3].duplicateOf, "A/Hory.jpg");
  assert.equal(rows.filter((row) => shouldCopy(row, false)).length, 2);
  assert.equal(rows.filter((row) => shouldCopy(row, true)).length, 4);
});

test("compares bytes beyond the sampled ends before marking identical images", async () => {
  const a = new Uint8Array(32_000);
  const b = a.slice();
  b[16_000] = 17;
  const { rows } = await planPhotos([photo("A/1.jpg", a), photo("B/2.jpg", b), photo("C/3.jpg", b)]);
  assert.equal(rows[1].duplicateOf, null);
  assert.equal(rows[2].duplicateOf, "B/2.jpg");
});

test("keeps the modification timestamp optional and handles invalid metadata gracefully", async () => {
  const file = photo("A/scan.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { lastModified: new Date(2023, 4, 1, 12).getTime() });
  const defaultPlan = await planPhotos([file]);
  const modifiedPlan = await planPhotos([file], { useModified: true });
  assert.equal(defaultPlan.rows[0].target, "Bez data/scan.png");
  assert.equal(modifiedPlan.rows[0].target, "2023/05/scan.png");
  assert.equal(modifiedPlan.rows[0].source, "Změna souboru");
});

test("quotes folder names safely for CSV spreadsheet import", async () => {
  const { rows } = await planPhotos([photo('=1+2/scan".jpg', await fixture("stul"))]);
  assert.equal(rows[0].target, "Bez data/scan_.jpg");
  assert.match(planCsv(rows, false), /"'=1\+2\/scan""\.jpg"/);
});

class MemoryFolder {
  constructor(name) {
    this.name = name;
    this.children = new Map();
    this.files = new Map();
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.children.has(name)) {
      if (!create) throw new DOMException("Missing", "NotFoundError");
      this.children.set(name, new MemoryFolder(name));
    }
    return this.children.get(name);
  }

  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name)) {
      if (!create) throw new DOMException("Missing", "NotFoundError");
      this.files.set(name, null);
    }
    return { createWritable: async () => {
      let content;
      return {
        write: async (file) => {
          if (name === "problem.jpg") throw Error("Simulated write failure");
          content = await file.arrayBuffer();
        },
        close: async () => this.files.set(name, content),
        abort: async () => {},
      };
    } };
  }

  async removeEntry(name) { this.files.delete(name); }
  async resolve(other) { return other === this ? [] : null; }
}

test("copies to a fresh folder, skips duplicates and isolates failed writes", async () => {
  const lake = await fixture("jezero");
  const { rows } = await planPhotos([photo("A/lake.jpg", lake), photo("B/copy.jpg", lake), photo("C/problem.jpg", "broken")]);
  const destination = new MemoryFolder("target");
  const result = await copyPlan(destination, rows);
  assert.equal(result.copied, 1);
  assert.equal(result.failures.length, 1);
  const output = await destination.getDirectoryHandle(result.folder);
  const period = await (await output.getDirectoryHandle("2024")).getDirectoryHandle("08");
  assert.deepEqual([...period.files.keys()], ["lake.jpg"]);
  assert.deepEqual(Buffer.from(period.files.get("lake.jpg")), lake);
  assert.equal((await output.getDirectoryHandle("Bez data")).files.size, 0);
  await assert.rejects(copyPlan(destination, rows, { source: destination }), /mimo složku/);
});
