# Třídič fotek

Třídič projde složku včetně podsložek a sestaví plán podle data pořízení do složek `rok/měsíc`. Běží lokálně a stačí mu Node.js 22.17 nebo novější.

## Spuštění

Pro rychlou kontrolu použij `--prehled`. Vypíše počty souborů, shodných kopií a fotek bez data i počet plánovaných kopií pro každý měsíc. Kompletní plán je k dispozici ve výchozím formátu JSON nebo přes `--csv`.

```powershell
node tridic.js 'D:\Fotky' --prehled
node tridic.js 'D:\Fotky' --csv > plan.csv
node tridic.js 'D:\Fotky' --prehled --kopirovat 'D:\Výstup'
```

Volba `--kopirovat` ukládá kopie do nové podsložky `Roztříděné-…` v existujícím cíli mimo zdroj. U kopií zachovává časy poslední změny a přístupu. `--vcetne-shodnych` zahrne i všechny shodné kopie. `node tridic.js --help` zobrazí úplný seznam voleb.

## Jak třídění funguje

1. Datum hledá v EXIF a pak v názvu souboru, například `IMG_20240814_123456.jpg`. Pokud datum nenajde, použije složku `Bez data`. Volba `--podle-zmeny` dovolí použít čas poslední změny souboru.
2. U souborů stejné velikosti porovná vzorky ze začátku a konce. Shodu ověří porovnáním všech bajtů po blocích. Když mají shodné soubory různé zdroje data, přednost dostane EXIF, pak název a potom čas změny.
3. Při kolizi názvů přidá číselnou příponu. Když při kopírování jediné verze selže čtení vybraného souboru, zkusí dostupnou ověřenou kopii pro stejnou cílovou cestu.

Pokud se některou položku nepodaří přečíst nebo zkopírovat, třídič vypíše její cestu a pokračuje s ostatními. Návratový kód je `0` při úspěchu, `1` při chybě, která zastaví celý běh, a `2` při chybě u jednotlivé položky.

## Zdrojový kód

- [`planner.js`](planner.js) sestavuje plán a porovnává obsah souborů.
- [`exif.js`](exif.js) čte datum pořízení z JPEG, TIFF včetně CR2, PNG a WebP s EXIF. Ostatní formáty, třeba HEIC, využijí datum z názvu nebo z volitelného času změny.
- [`disk.js`](disk.js) prochází složky a ukládá kopie.

`node --test` spustí testy se syntetickými metadaty a dočasnými soubory.
