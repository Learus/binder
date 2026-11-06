# Card Binder Simulator

A 3D trading card binder for Pokémon, Magic and Yu-Gi-Oh! cards. Search cards, pick a rarity, put them in binder pockets, flip pages, inspect cards up close with holographic foils, and keep several binders on the table.

## Desktop app

Download the build for your system from the GitHub releases page:

- **Windows:** `Card.Binder.Simulator-<version>-portable.exe` runs without installing (double-click it). `Card.Binder.Simulator-Setup-<version>.exe` is a regular installer.
- **macOS:** `.dmg`. The build is unsigned, so the first launch needs right-click → Open.
- **Linux:** `.AppImage`. Mark it executable, then run it.

Windows SmartScreen may warn about an unrecognised app because the builds aren't code-signed. Choose "More info" → "Run anyway".

The app stores binders and its image cache in your user data folder (File → Open data folder):

- Windows: `%APPDATA%\card-binder\data`
- macOS: `~/Library/Application Support/card-binder/data`
- Linux: `~/.config/card-binder/data`

## Sharing binders

**Export** saves the open binder as a `.binder.json` file. **Import** loads one and adds it to your table as a new binder. The file holds card references and rarities. Images download again on the other computer.

## Controls

- Click a pocket to select it, then click a search result to put the card there.
- Narrow a search by card type and by set (type in the set box to find one); either works without a name too. The **ab** button in the search box matches whole words only. Results show the printing's rarity code (UR, SIR, …) when the card database has it.
- Drag a search result onto a pocket to put it there, or drag a card between pockets (dropping on another card swaps them). Hold Shift while dropping to copy instead. Hold a dragged card beside the binder to turn the page.
- Click a card to inspect it. Ctrl+click removes it. Hover and press Ctrl+D to copy it to the next free pocket.
- ←/→ or the arrows beside the binder turn pages, or drag a page by its outer edge like a book (grab it beside or between the cards; pressing a card picks the card up). Type a page number to turn straight to it. C (or the button under the binder) closes or opens it, R resets the camera, T shows the whole table.
- Right-drag tilts the view up and down, middle-drag pans, the scroll wheel zooms.
- Click a closed binder on the table to swap it with the open one. Click an empty slot to start a new binder there.
- + Sheet inserts empty pages where the binder is open and moves the open pages to the right: two pages on a double spread, one page (page 1) on the front cover. − Sheet removes the open pages the same way, asking first if they hold cards.
- Each binder can hold 4, 9 or 16 pockets per page, in plastic sleeves or as graded slabs (4 per page). Changing it keeps your cards in order.
- Binder styles: a classic ring binder with a paper label, a padded zippered binder, or a ringless Pro binder with an elastic strap.
- Flip (F) in the close-up shows the card back for that game.
- Yu-Gi-Oh! Ultimate and Gold Rares have a print age slider in the close-up (older ultimates are greyer, older gold is darker and glossier). Yu-Gi-Oh! cards can use the old frame (not Link monsters, which never had one): the art box and its art shrink a little on all sides, like early prints.
- Every card has a condition in the close-up: sliders for creases, edge and corner wear, scratches, and fading/grime, plus NM / SP / LP / PO presets (NM is a clean card, all sliders at zero). Each card wears in its own places, and the back matches the front.
- The close-up shows prices for the card in its chosen rarity, from TCGplayer and Cardmarket (no API keys). Pokémon prices come from TCGdex (low / market / high for the variant). Magic prices come from Scryfall: this printing, plus the cheapest, median and dearest of all printings in the same finish. Yu-Gi-Oh! prices come from YGOPRODeck: the spread over every printing in that rarity, plus the card's cheapest printing in any rarity. Each marketplace has a logo, and there are search links for TCGplayer, Cardmarket and CardTrader (CardTrader's prices need an API token, so it's a link only).
- In the close-up, ‹ Prev / Next › (or ← / →) step through the binder's cards, crossing pages; the binder turns to the card's page behind it.
- Yu-Gi-Oh! cards carry the gold hologram sticker in the bottom-right corner, and their back is a sharp scan with the KONAMI and Yu-Gi-Oh! logos.

## Development

Needs Node 22 (`nvm use` picks it up from `.nvmrc`).

```bash
npm install
npm run dev
```

Then open http://127.0.0.1:5173. In development, data lives in `./data`.

Other scripts:

- `npm run app`: build and run the desktop app locally
- `npm run dist:win`: Windows portable exe (works from Linux; the exe keeps Electron's default icon there)
- `npm run dist:linux`: Linux AppImage
- `npm run dist`: packages for the current OS

## Releasing

`.github/workflows/release.yml` builds Windows, macOS and Linux packages and attaches them to a GitHub release. Push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Card sources

- Magic: Scryfall API (the search box accepts full Scryfall syntax, e.g. `t:dragon r:mythic`)
- Pokémon: TCGdex API
- Yu-Gi-Oh!: YGOPRODeck API

Images are fetched once through the local server and cached on disk.

## Layout

- `server/api.ts`: local API (search, image cache, binder files, table layout), used by both the Vite dev server and the desktop app
- `electron/main.ts`: desktop wrapper; serves the built page and the API on 127.0.0.1
- `src/three/holoMaterial.ts`: the foil shader; `src/foils.ts`: rarities per game
- `src/three/foilMap.ts`: per-card masks (title, stars, height, background)
- `src/three/binderScene.ts`: scene, page turning, closing, table slots
- `src/three/shelf.ts`: closed binders and table slot layout
- `src/three/styles.ts`: binder styles (covers, zipper, strap)
- `src/three/room.ts`: table, lighting and reflections
- `src/main.ts`: UI wiring
