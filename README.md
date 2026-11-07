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
5. **Printing.** Once the name is known, the app picks the printing from
   the closest look-alikes (`src/core/printing.ts`). It reads the printed
   border colour from the photo and checks it against Scryfall's
   `border_color`, which separates black-bordered originals from white-bordered
   reprints and gold-bordered collectibles. When printings still look the same
   but are priced differently, it prefers the regular printing over a promo and
   marks the pocket **Which printing?** for you to confirm. Examples are Beta
   vs. Collectors' Edition, or a set card vs. its promo.
6. **Review.** Green pockets were identified. Orange means check it, red means
   unknown. Tap any pocket to compare your photo with the match, switch
   printing or foil, or search by name.

## Prices and sell signals

- Prices are TCGplayer market prices in USD, via Scryfall, which updates them
  about once a day. The app refreshes prices for the cards you own from
  Scryfall's API automatically (at most twice a day), or right away with
  **Refresh prices**.
- **Worth selling now** lists cards trading at least 20% (and $1) above their
  own 30-day average. The average comes from MTGJSON's 90-day TCGplayer
  history (`npm run baselines`), so it works from the first day. Without that
  file, the app falls back to the daily prices it records itself.

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
npm run data         # build public/data/ from Scryfall (needs internet; ~10 min the first time, ~1 min after)
npm run baselines    # 30/90-day price baselines from MTGJSON (run after data; ~2 min)
npm run eval         # accuracy on real card scans in simulated binder photos (after data)
npm run smoke -- https://mtgdb.vercel.app   # upload a real-card binder video to a deployed site and check the results
npm run dev          # local dev server (https is needed for the camera on a phone; see below)
npm test             # unit + synthetic recognition tests
npm run typecheck
npm run build        # static site in dist/
npm run e2e          # end-to-end browser test with a synthetic binder video (after build)
```

`npm run data -- --limit 500` makes a quick partial database for trying things out.

## Deploying

The app is hosted on Vercel, linked to this GitHub repository. Every push to
`main` deploys: Vercel runs `npm run build:full` (see `vercel.json`), which
builds the card database, the price baselines and the site. The first build
fingerprints every card image (about 10 minutes). Later builds reuse the
fingerprints Vercel keeps in its build cache and take about a minute.

Prices for the cards you own refresh on the phone from Scryfall's API, at most
twice a day, so the site doesn't need rebuilding to stay current. A nightly
rebuild is optional: it picks up new sets and refreshes the 30-day averages.
To turn it on, create a Deploy Hook in the Vercel project (Settings › Git) and
save its URL as the GitHub secret `VERCEL_DEPLOY_HOOK`. The workflow in
`.github/workflows/nightly.yml` calls it daily and runs the tests on every
push.

Any static host works, but it needs **https**, because Safari only allows
camera access on secure pages.

On the iPhone: open the URL in Safari › Share › **Add to Home Screen**.

## Status and known limits

Measured with `npm run eval`, which renders 108 real card scans (half of them
worth $5+) into simulated binder photos and matches them against all 109,413
printings:

| Condition | Right card name | Confidently wrong | Pockets to check | Value error left in green pockets |
|---|---|---|---|---|
| 4K, even light | 99.1% | 0 | 11 of 108 | $8.73 of $4,095 |
| 4K, glare + hazy sleeves + warm light | 99.1% | 0 | 14 of 108 | $10.06 of $4,095 |
| 1080p, even light | 99.1% | 0 | 11 of 108 | $46.67 of $4,095 |

Most pockets to check are **Which printing?** flags. 1080p loses the border
detail that separates some originals from reprints, so record in 4K and
upload for the best results.

- These are simulated photos. Real glare, sleeve scratches, curled pages and
  autofocus will be harder, so the thresholds in `DEFAULT_RECOGNIZE` and
  `DEFAULT_PRINTING` still need checking against real footage.
- Foil vs. non-foil can't be told reliably from an overhead camera, so the app
  defaults to non-foil and you set foils in review.
- Card condition isn't assessed; prices are near-mint market prices.
- Live camera resolution in Safari can be lower than the Camera app's 4K. For
  the sharpest results, record the run in 4K and upload it.

Card data and images: [Scryfall](https://scryfall.com). This project is not
affiliated with Scryfall, TCGplayer or Wizards of the Coast. Magic: The
Gathering is © Wizards of the Coast.
