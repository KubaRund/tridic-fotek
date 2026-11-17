# Třídič fotek

**[Otevřít třídič](https://kubarund.github.io/tridic-fotek/)**

Třídič v prohlížeči připraví plán rozdělení fotek do složek podle roku a měsíce. Po kontrole umí uložit roztříděné kopie do nové složky. Čtení metadat, sestavení plánu i kopírování probíhají přímo v zařízení.

1. Vyber složku s fotkami nebo otevři ukázku.
2. Zkontroluj původní a cílové názvy a případné shodné kopie.
3. Stáhni plán jako CSV nebo v Chromu či Edge zvol cílovou složku a vytvoř roztříděné kopie. Původní soubory zůstanou na místě.

## Datum pořízení a shodné kopie

Datum se hledá v EXIF. Třídič čte metadata ve formátech JPEG, běžný TIFF (včetně CR2), PNG s blokem EXIF a WebP s blokem EXIF. Umí zahrnout také HEIC a další běžné formáty fotek. Když datum v podporovaných metadatech nenajde, zkusí datum ve jménu, například `IMG_20250202_114315.jpg`. Čas změny souboru je volitelný. Pro ostatní fotky vznikne složka `Bez data`.

Shoda názvu sama o sobě soubor nezařadí mezi kopie. Třídič vybere kandidáty podle velikosti a otisku okrajových částí, potom porovná celý obsah po blocích. Různé fotky se stejným cílovým názvem dostanou číselnou příponu. Ukázka ukazuje shodný soubor, konflikt názvu, datum z názvu i fotku bez data.

## Místní spuštění

```sh
python -m http.server 8771 --directory dist
```

Otevři `http://localhost:8771`. Testy v Node.js 20 nebo novějším spustíš příkazem `node --test`. `dist/` je statický web, který GitHub Pages publikuje z větve `gh-pages`.

<details>
<summary>Ukázkové fotky</summary>

Snímky ve složce [`dist/ukazka/`](dist/ukazka/) vznikly ve vestavěném generátoru obrázků. Testovací data pořízení jsou vložena do JPEG souborů `jezero.jpg` a `les.jpg`.

> Photorealistic 2 by 2 contact sheet of four distinct sample photographs for a Czech desktop photo organizer. Straight grid, no borders or gutters, each quadrant a complete independent landscape photograph. Top left: sunny wide alpine lake and rocky mountains. Top right: lush green forest trail in soft fog. Bottom left: still life on a warm beige desk with a vintage camera and a closed notebook, no people or readable lettering. Bottom right: dark evergreen mountains at blue hour with a little warm sunrise on the horizon. Natural documentary photography. No labels, text, logo or watermark.

</details>
