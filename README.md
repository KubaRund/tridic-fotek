# Třídič fotek

Algoritmus roztřídí soubory do složek `rok/měsíc`. Datum bere z EXIF, potom z názvu souboru. Pro chybějící datum použije `Bez data` nebo volitelně čas poslední změny souboru.

Soubory stejné velikosti porovná podle vzorku a potom podle všech bajtů. Shodné kopie označí v plánu. Při kolizi cílových názvů přidá číselnou příponu.

## Spuštění

Stačí Node.js 22.17 nebo novější. Výchozí příkaz vypíše plán v JSON. Volba `--kopirovat` zapíše kopie do nové podsložky uvnitř existující cílové složky mimo zdroj.

```powershell
node tridic.js 'D:\Fotky'
node tridic.js 'D:\Fotky' --csv > plan.csv
node tridic.js 'D:\Fotky' --kopirovat 'D:\Výstup'
```

Volba `--vcetne-shodnych` zahrne i shodné kopie. `--podle-zmeny` povolí použití času změny. `node tridic.js --help` zobrazí všechny volby.

## Zdrojový kód

- [`planner.js`](planner.js) sestavuje plán a porovnává obsah souborů.
- [`exif.js`](exif.js) čte datum pořízení z JPEG, TIFF včetně CR2, PNG a WebP s EXIF. Ostatní formáty, třeba HEIC, využijí datum z názvu nebo z volitelného času změny.
- [`disk.js`](disk.js) prochází složky a ukládá kopie.

`node --test` spustí testy se syntetickými metadaty a dočasnými soubory.
