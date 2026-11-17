import { isPhotoName, shouldCopy } from "./planner.js";

const missing = (error) => error?.name === "NotFoundError";

export async function readDirectory(root, progress = () => {}) {
  const directories = [{ handle: root, relative: root.name }];
  const entries = [];
  let ignored = 0;
  let unreadable = 0;
  for (const { handle, relative } of directories) {
    for await (const entry of handle.values()) {
      const name = `${relative}/${entry.name}`;
      if (entry.kind === "directory") {
        directories.push({ handle: entry, relative: name });
      } else if (isPhotoName(entry.name)) {
        try {
          entries.push({ file: await entry.getFile(), relative: name });
          progress(entries.length);
        } catch {
          unreadable += 1;
        }
      } else {
        ignored += 1;
      }
    }
  }
  return { entries, ignored, unreadable };
}

async function createOutput(destination) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${date} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const label = `Roztříděné fotky ${time} ${globalThis.crypto.randomUUID().slice(0, 8)}`;
  try {
    await destination.getDirectoryHandle(label);
  } catch (error) {
    if (missing(error)) return destination.getDirectoryHandle(label, { create: true });
    throw error;
  }
  throw Error("Výstupní složka už existuje. Zkus kopírování spustit znovu.");
}

async function writePhoto(directory, row) {
  try {
    await directory.getFileHandle(row.targetName);
    throw Error("V cíli už existuje soubor s tímto názvem.");
  } catch (error) {
    if (!missing(error)) throw error;
  }

  const target = await directory.getFileHandle(row.targetName, { create: true });
  let stream;
  try {
    stream = await target.createWritable({ mode: "exclusive" });
    await stream.write(row.file);
    await stream.close();
  } catch (error) {
    if (stream) await stream.abort().catch(() => {});
    // This placeholder was created by this run in the new output folder.
    await directory.removeEntry(row.targetName).catch(() => {});
    throw error;
  }
}

export async function copyPlan(destination, rows, { source, includeDuplicates = false, progress = () => {} } = {}) {
  if (source && await source.resolve(destination) !== null) {
    throw Error("Vyber cílovou složku mimo složku se zdrojovými fotkami.");
  }
  const selected = rows.filter((row) => shouldCopy(row, includeDuplicates));
  if (!selected.length) throw Error("V plánu nejsou žádné fotky ke zkopírování.");
  const output = await createOutput(destination);
  const folders = new Map();
  const failures = [];
  let copied = 0;
  for (const [index, row] of selected.entries()) {
    progress(index, selected.length);
    try {
      let directory = folders.get(row.folder);
      if (!directory) {
        directory = output;
        for (const part of row.folder.split("/")) directory = await directory.getDirectoryHandle(part, { create: true });
        folders.set(row.folder, directory);
      }
      await writePhoto(directory, row);
      copied += 1;
    } catch (error) {
      failures.push({ relative: row.relative, message: error.message });
    }
  }
  progress(selected.length, selected.length);
  return { folder: output.name, copied, failures };
}

function cell(value) {
  const raw = String(value ?? "");
  const text = /^[\r\n\t]|^\s*[=+@-]/.test(raw) ? "'" + raw : raw;
  return `"${text.replaceAll('"', '""')}"`;
}

export function planCsv(rows, includeDuplicates) {
  const records = [["Zdroj", "Datum", "Údaj z", "Cíl", "Shodný soubor", "Kopírovat", "Chyba čtení"]];
  for (const row of rows) {
    records.push([row.relative, row.date, row.source, row.target, row.duplicateOf,
      shouldCopy(row, includeDuplicates) ? "Ano" : "Ne", row.readError ? "Ano" : ""]);
  }
  return "\uFEFF" + records.map((row) => row.map(cell).join(";")).join("\r\n") + "\r\n";
}
