# Card Binder

A 3D trading card binder for Pokémon, Magic and Yu-Gi-Oh! cards. Search cards, pick a rarity, put them in binder pockets, flip pages, inspect cards up close with holographic foils, and keep several binders on the table.

## Desktop app

Download the build for your system from the GitHub releases page:

- **Windows:** `Card Binder-<version>-portable.exe` runs without installing (double-click it). `Card Binder-Setup-<version>.exe` is a regular installer.
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
- Click a card to inspect it. Ctrl+click removes it. Hover and press Ctrl+D to copy it to the next free pocket.
- ←/→ or the arrows beside the binder turn pages, or drag a page by its outer edge like a book. Type a page number to turn straight to it. C (or the button under the binder) closes or opens it, R resets the camera, T shows the whole table.
- Right-drag tilts the view up and down, middle-drag pans, the scroll wheel zooms.
- Click a closed binder on the table to swap it with the open one. Click an empty slot to start a new binder there.
- Each binder can hold 4, 9 or 16 pockets per page, in plastic sleeves or as graded slabs (4 per page). Changing it keeps your cards in order.
- Binder styles: a classic ring binder with a paper label, a padded zippered binder, or a ringless Pro binder with an elastic strap.
- Flip (F) in the close-up shows the card back for that game.
- Yu-Gi-Oh! Ultimate and Gold Rares have a print age slider in the close-up (older ultimates are greyer, older gold is darker and glossier). Any Yu-Gi-Oh! card can use the old frame, with the shorter art window of early prints.

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
