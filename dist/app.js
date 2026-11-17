import { planPhotos, shouldCopy } from "./planner.js";
import { copyPlan, planCsv, readDirectory } from "./files.js";

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("cs-CZ");
const canPickDirectory = typeof globalThis.showDirectoryPicker === "function";
const pageSize = 40;
const thumbExtensions = /\.(?:jpe?g|png|webp|avif|gif|bmp)$/i;
let state = { rows: [] };
let busy = false;
let page = 0;
let thumbnails = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function message(text, error = false) {
  $("message").hidden = !text;
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}

function progress(text, done, total) {
  $("progress").hidden = false;
  if (total) {
    $("progress").max = total;
    $("progress").value = done;
  } else {
    $("progress").removeAttribute("value");
  }
  message(total ? `${text} ${number.format(done)} z ${number.format(total)}` : text);
}

function pickable(row) {
  return shouldCopy(row, $("include-duplicates").checked);
}

function renderSummary() {
  const { rows } = state;
  const copies = rows.filter(pickable).length;
  $("source-name").textContent = state.label ?? (busy ? "Načítám fotky…" : "Vyber složku s fotkami.");
  $("photo-count").textContent = number.format(rows.length);
  $("copy-count").textContent = number.format(copies);
  $("duplicate-count").textContent = number.format(rows.filter((row) => row.duplicateOf).length);
  $("undated-count").textContent = number.format(rows.filter((row) => !row.date).length);
  const excluded = [];
  if (state.ignored) excluded.push(`${number.format(state.ignored)} jiných souborů`);
  if (state.unreadable) excluded.push(`${number.format(state.unreadable)} nepřístupných fotek`);
  $("preview-note").textContent = excluded.length ? `Mimo náhled: ${excluded.join(", ")}.` : "Složky ve výstupu mají tvar rok/měsíc.";
  $("copy-button").disabled = !canPickDirectory || busy || !copies;
  $("csv-button").disabled = busy || !rows.length;
  for (const id of ["folder-button", "demo-button", "use-modified", "include-duplicates"]) $(id).disabled = busy;
  $("copy-note").textContent = canPickDirectory
    ? "Kopie vzniknou v nové složce na místě, které vybereš."
    : "Pro uložení kopií do složky použij Chrome nebo Edge. Plán CSV můžeš stáhnout i tady.";
}

function revealThumb(row) {
  const tag = row.file.name.split(".").at(-1).toUpperCase();
  if (!thumbExtensions.test(row.file.name)) return element("span", "thumbnail fallback", tag);
  const img = element("img", "thumbnail");
  const url = URL.createObjectURL(row.file);
  thumbnails.push(url);
  img.src = url;
  img.alt = "";
  img.loading = "lazy";
  img.width = 54;
  img.height = 40;
  img.addEventListener("error", () => img.replaceWith(element("span", "thumbnail fallback", tag)), { once: true });
  return img;
}

function makePhotoRow(row) {
  const li = element("li", "photo");
  const from = element("div", "photo-source");
  const sourceDescription = element("div", "");
  sourceDescription.append(element("p", "photo-name", row.file.name), element("p", "photo-sub", row.relative));
  from.append(revealThumb(row), sourceDescription);

  const to = element("div", "");
  const target = element("p", "photo-target", row.target);
  const date = element("p", "photo-sub", row.date ? `${row.date} · ${row.source}` : row.source);
  to.append(target, date);
  const labels = element("div", "photo-flags");
  if (row.duplicateOf) {
    const duplicate = element("span", "flag duplicate", pickable(row) ? "Shodná kopie" : "Vynechá se shodná kopie");
    duplicate.title = `Shodný obsah s ${row.duplicateOf}`;
    labels.append(duplicate);
  }
  if (row.renamed) labels.append(element("span", "flag", "Nové jméno kopie"));
  if (row.readError) labels.append(element("span", "flag warning", "Neúplné čtení"));
  if (labels.childElementCount) to.append(labels);
  li.append(from, to);
  return li;
}

function renderRows() {
  const query = $("search").value.trim().toLocaleLowerCase("cs-CZ");
  const matches = {
    all: () => true, dated: (row) => Boolean(row.date), undated: (row) => !row.date,
    duplicate: (row) => Boolean(row.duplicateOf), renamed: (row) => row.renamed,
  }[$("filter").value];
  const rows = state.rows.filter((row) => matches(row) && `${row.relative} ${row.target}`.toLocaleLowerCase("cs-CZ").includes(query));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  page = Math.min(page, pages - 1);
  const start = page * pageSize;

  for (const url of thumbnails) URL.revokeObjectURL(url);
  thumbnails = [];
  $("results").replaceChildren(...rows.slice(start, start + pageSize).map(makePhotoRow));
  $("empty").hidden = Boolean(rows.length);
  $("empty").textContent = state.rows.length ? "Žádná fotka neodpovídá filtru." : "Vyber složku s fotkami nebo otevři ukázku.";
  $("paging").hidden = pages < 2;
  $("page-count").textContent = `Strana ${page + 1} z ${pages}`;
  $("previous").disabled = page === 0;
  $("next").disabled = page === pages - 1;
}

function render() {
  renderSummary();
  renderRows();
}

async function task(work) {
  if (busy) return;
  busy = true;
  $("failures").hidden = true;
  message("");
  renderSummary();
  try {
    await work();
  } catch (error) {
    if (error.name !== "AbortError") message(error.message, true);
  } finally {
    busy = false;
    $("progress").hidden = true;
    render();
  }
}

async function analyze(input, { reset = true } = {}) {
  const plan = await planPhotos(input.entries, {
    useModified: $("use-modified").checked,
    progress: (stage, done, total) => progress(stage === "metadata" ? "Čtu data pořízení…" : "Porovnávám obsah…", done, total),
  });
  state = { ...input, rows: plan.rows, ignored: plan.ignored + (input.scanIgnored ?? 0) };
  if (reset) {
    $("filter").value = "all";
    $("search").value = "";
    page = 0;
  }
  message(plan.rows.length ? "" : "Ve vybrané složce nejsou podporované formáty fotek.");
}

async function chooseFolder() {
  if (!canPickDirectory) {
    $("folder-input").click();
    return;
  }
  await task(async () => {
    const handle = await showDirectoryPicker({ id: "source-photos", mode: "read" });
    progress("Načítám složku…");
    const source = await readDirectory(handle, (count) => progress(`Načítám složku… ${number.format(count)} fotek`));
    await analyze({ entries: source.entries, label: handle.name, handle, scanIgnored: source.ignored, unreadable: source.unreadable });
  });
}

async function loadDemo() {
  await task(async () => {
    progress("Načítám ukázkové fotky…");
    const sceneNames = ["jezero", "les", "stul", "hory"];
    const blobs = await Promise.all(sceneNames.map(async (name) => {
      const response = await fetch(`./ukazka/${name}.jpg`);
      if (!response.ok) throw Error("Ukázkové fotky se nepodařilo načíst.");
      return response.blob();
    }));
    const examples = [
      [0, "Hory/IMG_2480.jpg"], [1, "Výlet/IMG_2480.jpg"], [0, "Záloha/IMG_2480.jpg"],
      [2, "Skeny/Poznámky.jpg"], [3, "Víkend/IMG_20250202_114315.jpg"],
    ];
    const entries = examples.map(([index, relative]) => ({
      relative, file: new File([blobs[index]], relative.split("/").at(-1), {
        type: "image/jpeg", lastModified: new Date(2025, 1, 7, 12).getTime(),
      }),
    }));
    await analyze({ entries, label: "Ukázkové fotky" });
  });
}

async function saveCopies() {
  await task(async () => {
    const includeDuplicates = $("include-duplicates").checked;
    const destination = await showDirectoryPicker({ id: "destination-photos", mode: "readwrite" });
    const result = await copyPlan(destination, state.rows, {
      includeDuplicates, source: state.handle, progress: (done, total) => progress("Kopíruji…", done, total),
    });
    const problems = result.failures.length;
    const prefix = `Uloženo: ${number.format(result.copied)} fotek do „${result.folder}“.`;
    message(problems ? `${prefix} Selhalo ${number.format(problems)} souborů.` : prefix, Boolean(problems));
    $("failures").hidden = !problems;
    $("failures").replaceChildren(...result.failures.slice(0, 10).map(({ relative, message: note }) => element("li", "", `${relative} · ${note}`)));
  });
}

$("folder-button").addEventListener("click", chooseFolder);
$("demo-button").addEventListener("click", loadDemo);
$("copy-button").addEventListener("click", saveCopies);
$("folder-input").addEventListener("change", (event) => {
  const files = [...event.currentTarget.files];
  event.currentTarget.value = "";
  if (!files.length) return;
  const entries = files.map((file) => ({ file, relative: file.webkitRelativePath || file.name }));
  task(() => analyze({ entries, label: entries[0].relative.split("/")[0] }));
});
$("csv-button").addEventListener("click", () => {
  const payload = planCsv(state.rows, $("include-duplicates").checked);
  const url = URL.createObjectURL(new Blob([payload], { type: "text/csv;charset=utf-8" }));
  const link = element("a", "");
  link.href = url;
  link.download = "plan-trideni-fotek.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("use-modified").addEventListener("change", () => {
  if (state.entries) task(() => analyze(state, { reset: false }));
});
$("include-duplicates").addEventListener("change", render);
for (const [id, event] of [["search", "input"], ["filter", "change"]]) {
  $(id).addEventListener(event, () => { page = 0; renderRows(); });
}
$("previous").addEventListener("click", () => { page -= 1; renderRows(); });
$("next").addEventListener("click", () => { page += 1; renderRows(); });
document.querySelector('a[href="#jak-to-funguje"]').addEventListener("click", () => {
  $("jak-to-funguje").open = true;
});

loadDemo();
