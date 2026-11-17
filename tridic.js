import { parseArgs } from "node:util";
import { scanPhotos, copyPhotos } from "./disk.js";
import { planPhotos, shouldCopy } from "./planner.js";

const help = `Třídič fotek podle data pořízení

Použití: node tridic.js <složka> [volby]

  --csv               Vypíše plán jako CSV místo JSON
  --podle-zmeny       Pro chybějící datum použije čas změny souboru
  --vcetne-shodnych   Zahrne do výstupu také bitově shodné kopie
  --kopirovat <cíl>   Zkopíruje plán do nové podsložky ve zvoleném cíli
  --help              Zobrazí tento návod

Bez volby --kopirovat příkaz pouze vypíše plán.
`;

function csvCell(value) {
  const raw = String(value ?? "");
  const safe = /^[\r\n\t]|^\s*[=+@-]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function planCsv(rows) {
  const output = [["Zdroj", "Datum", "Údaj z", "Cíl", "Shodný soubor", "Kopírovat", "Chyba čtení"]];
  for (const row of rows) {
    output.push([row.zdroj, row.datum, row.datumZ, row.cil, row.shodnySoubor,
      row.kopirovat ? "Ano" : "Ne", row.chybaCteni ? "Ano" : ""]);
  }
  return "\uFEFF" + output.map((row) => row.map(csvCell).join(";")).join("\r\n") + "\r\n";
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      csv: { type: "boolean" },
      "podle-zmeny": { type: "boolean" },
      "vcetne-shodnych": { type: "boolean" },
      kopirovat: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || process.argv.length === 2) {
    process.stdout.write(help);
    return;
  }
  if (positionals.length !== 1) throw Error("Zadej jednu zdrojovou složku. Příklady zobrazíš volbou --help.");
  if (values.kopirovat === "") throw Error("Za --kopirovat zadej cílovou složku.");

  const source = await scanPhotos(positionals[0]);
  const { rows } = await planPhotos(source.entries, { useModified: values["podle-zmeny"] });
  const includeDuplicates = values["vcetne-shodnych"];
  const report = rows.map((row) => ({
    zdroj: row.relative, datum: row.date, datumZ: row.source, cil: row.target,
    shodnySoubor: row.duplicateOf, kopirovat: shouldCopy(row, includeDuplicates), chybaCteni: row.readError,
  }));
  const problems = source.errors.slice();
  if (values.kopirovat) {
    const result = await copyPhotos(source.root, values.kopirovat, rows, includeDuplicates);
    if (result.folder) console.error(`Zkopírováno ${result.copied} fotek do ${result.folder}`);
    problems.push(...result.errors);
  }
  if (values.csv) {
    process.stdout.write(planCsv(report));
  } else {
    console.log(JSON.stringify({ vynechaneFormaty: source.ignored, soubory: report }, null, 2));
  }
  for (const error of problems) console.error(`${error.path} – ${error.message}`);
  if (problems.length) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
