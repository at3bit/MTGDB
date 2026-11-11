# MTGDB: binder scanner and collection pricer

A web app for iPhone that scans *Magic: The Gathering* binder pages and tracks
what your collection is worth.

The most accurate way in: take a photo of each page (or open binder) with the
iPhone Camera app and upload them all at once. You can also mount the phone on a
tripod facing down at the table and flip through a 9-pocket binder on video or
with the live camera (automatically, on a timer, or with a Snap button). The app
captures each page or spread, identifies every card, and prices it in USD
(TCGplayer market prices via Scryfall). It saves where each card lives (binder,
page, slot) and flags cards trading well above their own recent average.

You add it to your iPhone home screen from Safari. It isn't on the App Store, so
there's no Apple developer account or TestFlight. To share it, send a friend the
link. Each person's collection is stored only on their own phone.

## How recognition works

1. **Page-turn detection and capture** (`src/core/motion.ts`, `src/core/capture.ts`,
   `src/core/focus.ts`). The app samples the video 15 times a second (an
   uploaded video is stepped through frame by frame at that rate, never played
   fast) and compares small thumbnails, adjusted for brightness so the camera's
   auto-exposure settling after a turn doesn't count as movement. While the page
   is still it also measures **focus** on small full-resolution patches of each
   page, because the camera refocuses after every turn and the page-turn
   detector can't see that (a refocus looks like a still page). It keeps the
   sharpest frame of each page and sends the spread when the next turn starts
   (uploads) or once focus stops improving (live camera, 0.25–1.5 s). Repeat
   captures of the same spread (a hand passed over, or rested on the page and
   lifted) are merged by card name, keeping the better reading of each pocket.
   When pages are flipped quickly and never settle, the sharpest frame of the
   pause is captured instead, and dropped if it caught the page mid-turn
   (almost nothing matches).
2. **The outline** (`src/ui/QuadOverlay.tsx`, `src/core/scan.ts`). One outline
   with four corners, around the page, or around both pages of an open binder
   with a handle for the gap at the spine. It stays where you put it: each
   capture is read with it as it is. Only a page where some cards don't read is
   also tried at nearby placements (re-found by the typical edge pattern of a
   card, `src/core/align.ts`), and a placement is used only if it identifies at
   least 2 more cards. The outline on screen never moves by itself; when a page
   had to be found elsewhere the scan screen suggests Pause & adjust. (The page
   finder used to move the outline on every capture; it nudged even a correct
   outline by ~4% of a pocket, and real binders pulled it further.)
3. **Pocket extraction** (`src/core/geometry.ts`, `src/core/recognize.ts`). Each pocket is
   perspective-corrected into a straight card image. When a spread comes with two
   frames (each page sharpest in a different one), the app keeps the sharper,
   less glary crop of each pocket. A pocket with little fine detail is only
   called empty if it also doesn't match a card: blur removes detail too, and
   the fingerprint still matches cards far blurrier than that (pages read from
   a blurry photo are flagged in the review). The review photo of each pocket
   is cut straight from the full-resolution frame.
4. **Image match** (`src/core/fingerprint.ts`). Each card gets a 160-bit visual
   fingerprint: the whole card's structure, the art box's structure, and the
   colour layout. It's compared against the fingerprints of every paper printing
   on Scryfall (~100k). Several slightly shifted placements are tried, since
   cards slide around in their pockets. A spread takes about half a second.
5. **Name reading** (`src/app/ocr.ts`). Every card's title line is read with
   Tesseract (served by the app itself) and fuzzy-matched to card names, as a
   cross-check: when it agrees with the image match the card is confirmed;
   when it clearly reads as a different card, the pocket is flagged and offers
   both. For a card the image match didn't identify, a clean read identifies
   it; a weak read is only offered as a suggestion. (On its own OCR reads 44% of
   names at 1080p and ~80% even in 12 MP photos, so it checks the image match
   rather than replacing it; whenever the two agreed in testing, they were
   right.)
6. **Printing.** Once the name is known, the app picks the printing from
   the closest look-alikes (`src/core/printing.ts`). It reads the printed
   border colour from the photo and checks it against Scryfall's
   `border_color`, which separates black-bordered originals from white-bordered
   reprints and gold-bordered collectibles. When printings still look the same
   but are priced differently, it prefers the regular printing over a promo and
   marks the pocket **Which printing?** for you to confirm. Examples are Beta
   vs. Collectors' Edition, or a set card vs. its promo. The chooser shows a
   sharp crop of your card's set symbol next to each printing's, so you can
   compare them by eye. (Deciding by the symbol automatically was tested and
   did no better than the default pick: the symbol is only ~20 px at 4K and
   many look-alikes have identical symbol areas. See `src/core/symbol.ts`.)
7. **Empty sleeves** (`src/app/session.ts`). An empty sleeve shows whatever
   is behind it. If the sleeve's other side holds a card, you see a card
   back, which is recognised and treated as empty. If both sides are empty,
   you see the card on the next sheet. That card shows up in the same slot of
   a later spread (right page) or an earlier one (left page), so the app
   records it once, where it really is, and marks the other copy "seen
   through sleeve". Repeat captures are judged per page, because see-through
   cards can make the right page look unchanged after a turn while the left
   page always changes.
8. **English only** (default; a checkbox on the scan setup screen). Scryfall
   lists ~2,100 non-English printings, and 1,353 of them share their art with
   an English printing, so a photo of an English card could come back as, say,
   the Japanese one. Matching and printing choices skip them unless the box is
   unticked.
9. **Check, card by card** (`src/ui/CardCheck.tsx`). When a scan finishes, the
   app opens a check of every card before anything is saved: your photo next
   to the proposed match, with name, edition and price side by side ("Scanned
   as" vs. "This option"). Swipe the match (or tap ‹ ›) through the likely
   options: other printings of that card, most alike first, then other cards
   it looks like. If it's way off, search the name at the top and swipe its
   printings. Pick the finish, compare set symbols, then **Save + continue**;
   **‹ Back** returns to the previous card. You can stop any time (‹ Pages),
   pick up again with **Check cards**, or tap any card on the pages to check
   just that one. Checked cards are marked ✓.
10. **Review.** Green pockets were identified. Orange means check it, red means
   not identified (no guess is shown). A name the app isn't sure of is shown
   as a question ("Lightning Bolt?") and isn't saved or counted until you
   check it. Tap any pocket to compare your photo with the match, switch
   printing or foil, or search by name. Switch between the page-by-page
   gallery and a list, sort by price, 30-day gain or drop, name or set, and
   search by name.

## Scanning controls

- **Upload photos** (most accurate): pick all the photos at once, in page
  order. Line up the outline on the first; with **Line up the outline on each
  photo** (on by default, for photos taken by hand) the app stops on every
  photo so you can adjust it, or skip the photo. A photo of a different shape
  always stops for lining up.
- **Live camera**: capture pages **Automatically** (a quarter-second pause per
  spread is enough; half a second is safer), **On a timer** (a shot every 3-8 s
  with a countdown, a click and a flash: turn the page after each), or **When I
  tap Snap**. Snap page also works in automatic mode, and Space, Enter, → or
  Page Down snap too, so a Bluetooth page-turner pedal or remote can be the
  shutter.
- **Pause & adjust**: as the page stacks shift, pause, drag the outline onto
  the pages as they sit now, and continue.
- **Share scan diagnostics** (review screen): a zip of the photos the app
  captured (the last 30, up to 2560 px) and what it read from each, to send
  when a scan comes out wrong. Nothing leaves the phone until you share it.
- If the video stops responding part-way (Safari now and then drops a seek;
  each is retried) or the card reader crashes (it restarts), the scan says so
  and keeps everything captured up to then, rather than freezing.
- Quantities aren't tracked: a binder stores one entry per printing (and
  finish), and the collection totals count each printing once.
- **Do I own…?** on the home screen searches every binder; **Browse all**
  lists the whole collection with the same views, sorts and search.

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
npm run data:version # public/data/version.json: content hashes of the data files (run last)
npm run eval         # accuracy on real card scans in simulated binder photos (after data)
npm run smoke -- https://mtgdb.vercel.app   # upload a real-card binder video to a deployed site and check the results
npm run sim          # simulate scanning a big binder (drifting pages, nudges, auto-exposure, resting hands) and report losses
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

Every build rebuilds the catalogue from Scryfall's latest data, so the data
files change from one deployment to the next. `version.json` lists a content
hash for each file; the app asks for `cards.json?v=<hash>` and so on, and checks
what it receives, so a phone never pairs a cached file from one deployment with
a file from another.

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

Whole-binder runs, measured with `npm run sim` (real card scans, simulated
pages drifting as the stacks change, nudges, auto-exposure, hands resting on
the page):

| Run | Before page tracking | Now |
|---|---|---|
| 16 spreads, pages drift 29% of a card width | 46% of cards right, 3 spreads missed | 287/288 right, none wrong |
| 24 spreads, thick binder, drift 73% of a card width | not run | 429/432 right; the 3 misses flagged orange |
| 16 spreads, fast flipping (0.5–0.9 s pauses) | not run | 286/288 right |

Flipping speed (16 spreads, `--hold-min/--hold-max`, `--no-brief` for the
settle-only rule):

| Pause between flips | Settle only, 10 samples/s | Now: 15 samples/s + quick-pause capture |
|---|---|---|
| 0.9–1.7 s | 99% of cards found | 99% |
| 0.5–0.9 s | 90% | 99% |
| 0.2–0.45 s | 56% | 97%, all 16 spreads |
| 0.15–0.3 s | 55% | 84–96% |

Blur (`npm run eval -- --defocus 2`, `npm run sim -- --refocus 0.5`): real
cards in simulated 4K frames, defocused by a Gaussian of N% of a card's width.
Before, a blurry card was taken for an empty sleeve:

| Defocus | Before (detail test only) | Now |
|---|---|---|
| 1% | 96% of cards | 96% |
| 2% | 38% | 97% |
| 3% | 0% | 96% |

Whole binders where the camera refocuses after each turn (blurry for the
first part of every pause), before -> now:

| Run | Before | Now |
|---|---|---|
| 0.5 s refocus, relaxed pace | 86% found; 17 of 26 captures out of focus | 100%; 2 of 26 |
| 0.8 s refocus, 0.5–0.9 s pauses | 49% found, 17 wrong shown green | 99%, none wrong |
| 0.5 s refocus, 0.2–0.45 s pauses | 56% | 95% |

Binders with empty sleeves (`npm run sim -- --empty 0.3` / `0.6`), where
empty sleeves show card backs or the next sheet's card:

| Run | Before | Now |
|---|---|---|
| 30% of sleeves empty: 201 cards | 281 entries (68 duplicates, 23 in the wrong place, 59 junk from card backs) | 201 entries, 199 exactly right, none wrong shown green |
| 60% empty: 103 cards | two spreads merged into one; 240 entries, 40% right | 16/16 spreads, 108 entries, 94% exactly right, every card found |

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
