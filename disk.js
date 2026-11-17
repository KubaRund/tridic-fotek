import { openAsBlob } from "node:fs";
import { mkdir, mkdtemp, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isPhotoName, shouldCopy } from "./planner.js";

async function directoryPath(name) {
  const absolute = await realpath(name);
  if (!(await stat(absolute)).isDirectory()) throw Error(`Cesta není složka: ${name}`);
  return absolute;
}

const displayPath = (root, path) => relative(root, path).split(sep).join("/");

export async function scanPhotos(directory) {
  const root = await directoryPath(directory);
  const pending = [root];
  const entries = [];
  const errors = [];
  let ignored = 0;

  for (const current of pending) {
    let contents;
    try {
      contents = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (current === root) throw error;
      errors.push({ path: displayPath(root, current), message: error.message });
      continue;
    }
    for (const item of contents) {
      const path = join(current, item.name);
      if (item.isDirectory()) {
        pending.push(path);
      } else if (item.isFile() && isPhotoName(item.name)) {
        try {
          const modified = (await stat(path)).mtimeMs;
          const blob = await openAsBlob(path);
          entries.push({
            relative: displayPath(root, path),
            file: {
              name: item.name, size: blob.size, lastModified: modified,
              slice: (start, end) => blob.slice(start, end), stream: () => blob.stream(),
            },
          });
        } catch (error) {
          errors.push({ path: displayPath(root, path), message: error.message });
        }
      } else {
        ignored += 1;
      }
    }
  }
  return { root, entries, ignored, errors };
}

async function writeCopy(file, path) {
  const handle = await open(path, "wx");
  try {
    await pipeline(Readable.fromWeb(file.stream()), handle.createWriteStream());
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(path).catch(() => {});
    throw error;
  }
}

export async function copyPhotos(source, destination, rows, includeDuplicates = false) {
  const root = await directoryPath(source);
  const target = await directoryPath(destination);
  const fromSource = relative(root, target);
  const outside = fromSource === ".." || fromSource.startsWith(`..${sep}`) || isAbsolute(fromSource);
  if (!outside) throw Error("Zvol cílovou složku mimo zdrojovou složku.");

  const selected = rows.filter((row) => shouldCopy(row, includeDuplicates));
  if (!selected.length) return { folder: null, copied: 0, errors: [] };
  const folder = await mkdtemp(join(target, "Roztříděné-"));
  const errors = [];
  let copied = 0;
  const ready = new Set();
  for (const row of selected) {
    const period = join(folder, ...row.folder.split("/"));
    try {
      if (!ready.has(period)) {
        await mkdir(period, { recursive: true });
        ready.add(period);
      }
      await writeCopy(row.file, join(period, row.targetName));
      copied += 1;
    } catch (error) {
      errors.push({ path: row.relative, message: error.message });
    }
  }
  return { folder, copied, errors };
}
