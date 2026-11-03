# MTGDB: binder scanner and collection pricer

A web app for iPhone that scans *Magic: The Gathering* binder pages and tracks
what your collection is worth.

Mount the phone on a tripod facing down at the table and open a 9-pocket binder
under it. Then flip through the pages. The app spots each page turn, captures the
open spread (18 pockets), identifies every card, and prices it in USD
(TCGplayer market prices via Scryfall). It saves where each card lives (binder,
page, slot) and flags cards trading well above their own recent average.

You add it to your iPhone home screen from Safari. It isn't on the App Store, so
there's no Apple developer account or TestFlight. To share it, send a friend the
link. Each person's collection is stored only on their own phone.

## How recognition works

1. **Page-turn detection** (`src/core/motion.ts`). The app samples the video
   ~6 times a second and compares small thumbnails. When the view goes still
   after movement, it captures that spread. If a still view matches the last
   capture (a hand passed over without turning), it's skipped.
2. **Pocket extraction** (`src/core/geometry.ts`, `src/core/recognize.ts`).
   You line up an outline over the pages once per tripod setup. Each pocket is
   perspective-corrected into a straight card image. When two frames of a spread
   are captured, the app keeps the sharper, less glary crop of each pocket.
3. **Image match** (`src/core/fingerprint.ts`). Each card gets a 160-bit visual
   fingerprint: the whole card's structure, the art box's structure, and the
   colour layout. It's compared against the fingerprints of every paper printing
   on Scryfall (~100k). Several slightly shifted placements are tried, since
   cards slide around in their pockets. A spread takes about half a second.
4. **Name reading** (`src/app/ocr.ts`). When the image match isn't conclusive,
   the app reads the title line with Tesseract (served by the app itself) and
   fuzzy-matches it to card names. It then picks the closest-looking printing of
   that name.
5. **Review.** Green pockets were identified. Orange means check it, red means
   unknown. Tap any pocket to compare your photo with the match, switch
   printing or foil, or search by name.

## Prices and sell signals

- Prices come from the card database, which the nightly GitHub Action rebuilds
  (Scryfall updates prices about once a day). **Refresh prices** also pulls
  current prices for the cards you own straight from Scryfall's API.
- The app saves a daily price point for every card you own. Once a card has a
  few days of history, the home screen lists **Worth selling now**: cards at
  least 20% and $1 above their own 30-day average.

## Project layout

```
src/core/      recognition engine (pure TypeScript; runs in the browser, in Node and in tests)
src/app/       browser plumbing: camera/video capture, worker, run controller, OCR, storage, prices
src/ui/        React screens
scripts/       build-data.ts (Scryfall -> public/data), e2e.ts (browser test), copy-vendor.mjs
tests/         unit tests + synthetic binder renderer
.github/       nightly data build + deploy
```

## Commands

```bash
npm install          # also copies the OCR engine into public/vendor
npm run data         # build public/data/ from Scryfall (needs internet; the first run takes a while)
npm run dev          # local dev server (https is needed for the camera on a phone; see below)
npm test             # unit + synthetic recognition tests
npm run typecheck
npm run build        # static site in dist/
npm run e2e          # end-to-end browser test with a synthetic binder video (after build)
```

`npm run data -- --limit 500` makes a quick partial database for trying things out.

## Deploying

The site is fully static. The included workflow (`.github/workflows/nightly.yml`)
builds the data, tests, builds and deploys to Vercel once you add
`VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as repository secrets.
It only runs on its own (nightly and on pushes to `main`) once you add a
repository variable `NIGHTLY_ENABLED` set to `true`. You can always start a run
by hand from the Actions tab. The first run fingerprints every card image, so it
takes the longest. Later runs reuse the cached fingerprints.
Any static host works, but it needs **https**, because Safari only allows camera
access on secure pages.

On the iPhone: open the URL in Safari › Share › **Add to Home Screen**.

## Status and known limits

- Tested so far with **synthetic** cards rendered into simulated binder video:
  54/54 pockets across 3 spreads, with glare, colour cast and misalignment, and
  page-turn de-duplication. Real-card accuracy hasn't been measured yet. That
  needs the Scryfall-built database and real photos, and the thresholds in
  `DEFAULT_RECOGNIZE` will likely need tuning against real footage.
- Foil vs. non-foil can't be told reliably from an overhead camera, so the app
  defaults to non-foil and you set foils in review.
- Card condition isn't assessed; prices are near-mint market prices.
- Live camera resolution in Safari can be lower than the Camera app's 4K. For
  the sharpest results, record the run in 4K and upload it.

Card data and images: [Scryfall](https://scryfall.com). This project is not
affiliated with Scryfall, TCGplayer or Wizards of the Coast. Magic: The
Gathering is © Wizards of the Coast.
