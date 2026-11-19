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
2. **The outline and which way up** (`src/ui/QuadOverlay.tsx`, `src/core/scan.ts`).
   If a page reads badly, the app also reads it turned 180° (the binder facing
   the other way) and 90° each way, keeps the turn that identifies clearly more
   cards, and carries it through the run. On real photos taken with the binder
   upside down, all 36 pockets were wrong without this; with it, all 23 cards
   were named right and all 13 blank fillers read as empty.
   Which way is better is judged by how close the cards come to real ones
   (mean fingerprint distance), not only by how many are identified for sure:
   on 30 real pages (227 cards, 43 blank fillers), read the wrong way up the
   cards averaged 36-41 (they match nothing in particular), the right way
   4-20 closer on 29 of them, while counting sure matches got 3 pages
   backwards (a wrong way up can turn up a couple of chance "matches"). A page
   turns if its cards come 3.5 closer and within 37. If neither settles it,
   the outline is also fitted both ways up (separately: the fit follows the
   name bar and type line) and compared. Each page read on its own: before,
   the turn was missed on 5 of the first 15 (66 of 110 cards named right, 5
   confidently wrong); now on 1 of the 30 (193 of 227 named right, none
   confidently wrong). The page still missed has 4 cards, 3 of them glossy
   foils, and reads badly either way; in a run the turn carries over from the
   previous page. With the outline given the right way up, no page is turned.
   The outline itself: One outline
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
   cards slide around in their pockets, and every placement helps build the
   shortlist (with only the two likeliest, 3 of 23 cards on real photos were
   missed although they matched well). A page takes about half a second.
   A card that isn't matched confidently gets a **second look** with smaller,
   shifted windows (86–94% of the pocket, nudged up to 4% sideways and from 3%
   up to 6% down): in roomy pockets the card sits smaller than the outline and
   rests low. On a real blue binder the first look matched none of 10 such
   cards (and so read their names from the wrong strip); the second look
   matched all 10 by clear margins. Its unsure result replaces the first
   look's only if it's closer by 8 or more, since more windows also let a wrong
   card fit a little better by chance.
5. **Name reading** (`src/app/ocr.ts`). Every card's title line is read with
   Tesseract (served by the app itself) and fuzzy-matched to card names, as a
   cross-check: when it agrees with the image match the card is confirmed;
   when it clearly reads as a different card, the pocket is flagged and offers
   both. For a card the image match didn't identify, a clean read identifies
   it; a weak read is only offered as a suggestion. (On its own OCR reads 44% of
   names at 1080p and ~80% even in 12 MP photos, so it checks the image match
   rather than replacing it; whenever the two agreed in testing, they were
   right.)
   The read is cleaned before matching: stray letters, digits and symbols at
   its ends (a cut-off first letter, the mana cost read as "2% |" or "L&E") are
   dropped, and a read cleaned down to fewer than 4 letters says nothing. On a
   real binder's 179 reads, clean reads that identify a card went from 59 to
   76, none wrong, and every read scoring 0.75+ (80 of them) was right. For a
   card the picture didn't settle, a fair read (0.65+, right 3 times in 4)
   becomes the first guess, still marked to check: the picture's unsure guess
   was right only 19 times in 34.
   **Collector line.** Each identified card's bottom strip is also cropped and
   read, for cards whose name has more than one printing and cards the app is
   unsure of: since 2015 cards print the number and set ("079/249 U" over
   "MM2 • EN"), older ones end the copyright line with number / cards in the
   set ("61/145"). That names the printing outright, where the picture can't
   (`parseCollectorLine`, `printingFromCollector`); page context then leaves
   it alone and it anchors the page's set. On 30 real page photos at half the
   app's resolution it named the printing of 95 of 227 cards. For a card the
   app was unsure of, a set code and number naming another card (right 8
   times in 9 there, but once a misread number replaced a right guess) make
   it the first guess only when the picture had it among its candidates or
   the name read points to it; otherwise it's offered among the options. On
   cards already identified a misread digit can name another card, so there
   it only picks among the card's own printings.
6. **Printing.** Once the name is known, the app picks the printing from
   the closest look-alikes (`src/core/printing.ts`). It reads the printed
   border colour from the photo and checks it against Scryfall's
   `border_color`, which separates black-bordered originals from white-bordered
   reprints and gold-bordered collectibles. When printings still look the same
   but are priced differently, it prefers the regular printing over a promo and
   marks the pocket **Which printing?** for you to confirm. Examples are Beta
   vs. Collectors' Edition, or a set card vs. its promo. The chooser shows a
   sharp crop of your card's set symbol next to each printing's, so you can
   compare them by eye. Different printings of a card are kept as separate
   entries (they're worth different amounts); two copies of the same printing
   are one entry, whose quantity you set on its detail screen afterwards. (Deciding by the symbol automatically was tested and
   did no better than the default pick: the symbol is only ~20 px at 4K and
   many look-alikes have identical symbol areas. See `src/core/symbol.ts`.)

   Two rules come from a real 205-card scan (a binder sorted by set), where
   9 of the 34 cards that have a look-alike in *The List* were saved as the
   List reprint and one as a foil-only ★ printing:
   - **Exact twins lose ties.** A List reprint is the original card with a
     tiny planeswalker mark, and a ★ printing is the foil-only copy of a
     regular one; a photo can't tell them apart (their fingerprints differ by
     2-6 bits), so photo noise used to decide. They now give way to the
     regular printing unless the photo is clearly closer to them (5 bits).
     Look-alikes far apart in price are still flagged **Which printing?**,
     whatever the preference.
   - **The page's set.** A page's set is the one the most cards on it could
     be from, judging by the look of their printings (look-alikes within 14
     bits: reprints differ from the original in the border, copyright line
     and set symbol, most by 7.5-12.5 bits, closer than photo noise can tell
     apart); counting the app's own picks failed when they scattered over
     reprints (a page of Magic 2010 cards read as 10th Edition, Duel Deck and
     Fifth Dawn reprints). If a set covers at least 2 of the other cards and
     40%, each card takes its look-alike from that set, if it fits the photo
     within 8 bits of the best fit, never a List or ★ twin over the regular
     card. Cards you picked, and printings read off the collector line, count
     with their own set and are never changed. Replayed on a real binder's 206
     correctly named cards (their photos from the scan report), the printing
     came out right for 154 with the old rule and 165 now.
   Replaying that scan's checked list through the new rules changes exactly
   those 10 cards and none of the other 195; on the random-printing
   evaluation (`npm run eval`) exact printings went from 75.0% / 67.6% /
   70.4% to 75.9% / 68.5% / 70.4%, card names unchanged.
7. **Empty sleeves** (`src/app/session.ts`). An empty sleeve shows whatever
   is behind it. If the sleeve's other side holds a card, you see a card
   back, which is recognised and treated as empty. If both sides are empty,
   you see the card on the next sheet. That card shows up in the same slot of
   a later spread (right page) or an earlier one (left page), so the app
   records it once, where it really is, and marks the other copy "seen
   through sleeve". Repeat captures are judged per page, because see-through
   cards can make the right page look unchanged after a turn while the left
   page always changes.
8. **Before a scan** (setup screen):
   - **Collection**: pick one of your collections from the list to add the
     scan to it (the most recently scanned is selected), or tap **Create new
     collection** and name it. (The app calls a saved set of cards a
     *collection*; *binder* means the physical one.)
   - **What's in this collection?** White, Blue, Black, Red, Green, Multicolor,
     Artifact, Land, Colorless (any mix; remembered per collection). Every
     printing's colours and type come from Scryfall. The matcher still looks at
     every card, but one in the collection's colours wins unless another matches
     clearly better (by more than 6 points), and confidence is judged against
     other cards of those colours. A card outside them is flagged to check.
   - **Empty sleeves hold a blank card**: nothing can show through, so the
     see-through logic below is off. Blank filler cards are recognised either
     way (a pocket that's mostly flat and bright is empty: blanks measured
     0.68-0.75 on real photos, real cards at most 0.07, and of 3,400 Scryfall
     images only Scryfall's own blank substitute cards come near).
9. **English only** (default; a checkbox on the scan setup screen). Scryfall
   lists ~2,100 non-English printings, and 1,353 of them share their art with
   an English printing, so a photo of an English card could come back as, say,
   the Japanese one. Matching and printing choices skip them unless the box is
   unticked.
10. **Check, card by card** (`src/ui/CardCheck.tsx`). When a scan finishes, the
   app opens a check of every card before anything is saved: your photo next
   to the proposed match, with name, edition and price side by side ("Scanned
   as" vs. "This option"). Swipe the match (or tap ‹ ›) through the likely
   options: other printings of that card, most alike first, then other cards
   it looks like. If it's way off, search the name at the top and swipe its
   printings. Pick the finish, compare set symbols, then **Save + continue**;
   **‹ Back** returns to the previous card. You can stop any time (‹ Pages),
   pick up again with **Check cards**, or tap any card on the pages to check
   just that one. Checked cards are marked ✓.
11. **Review.** Green pockets were identified. Orange means check it, red means
   not identified (no guess is shown). A name the app isn't sure of is shown
   as a question ("Lightning Bolt?") and isn't saved or counted until you
   check it. Tap any pocket to compare your photo with the match, switch
   printing or foil, or search by name. Switch between the page-by-page
   gallery and a list, sort by price, 30-day gain or drop, name or set, and
   search by name.

## Scanning controls

- **Upload photos** (most accurate): pick all the photos at once, in page
  order. Line up the outline on the first and tap Read: the whole batch runs
  with that outline, without stopping, one photo at a time. **Pause & adjust**
  stops at once on the photo on screen; after you adjust the outline that
  photo is read again (its misaligned reading is replaced) and the outline is
  used for every photo after it. (Measured with the CPU slowed 4x: Pause used
  to take effect after 8.7 s, with photos queued behind it; now 0.07 s.)
  Card names are read once the batch is done, so the scan gets the phone's
  time, and photos go to the recognizer as images whose pixels it reads
  itself, not copied out on the page's thread.
  **Stop on each photo to adjust the outline** (off by default; for photos
  taken by hand) stops on every photo instead, with Use this photo / Skip. A
  photo of a different shape (portrait vs landscape) always stops.
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
- **Quantities**: a scan stores one entry per printing (and finish), as one
  copy. To record more copies, open the card and use the **Quantity** − / +
  stepper (1–999). Every total counts each copy: a card's value is its price
  × quantity in lists, tiles and the detail screen, and the collection and
  portfolio totals and card counts add up the copies. The CSV export has
  Quantity and Total USD columns. Adding a new scan to a collection keeps the
  quantities already set.
- **Delete a collection** from its ⋯ menu (Delete collection, then confirm).
- **Autosave**: a scan in progress is saved on the phone (IndexedDB) as each
  photo is read, after every 5 Save + continue taps, when the scan finishes
  and whenever the app goes to the background. If the app crashes or iOS
  closes it, the home screen offers **Resume** (the photos, readings and
  cards checked so far come back, and the card check carries on from the
  first unchecked card) or Discard. Saving the collection or discarding the scan
  forgets the autosave. Each card's photo is written once; later saves only
  rewrite the small list of readings.
- **Adding to a collection**: a scan added to an existing collection goes
  after its pages (printings it already has aren't added twice), so a big
  binder can be scanned in several sittings. To start a collection over,
  delete it and create it again.
- **Unsure guesses**: when the app isn't sure of a card (or can't identify
  it), every candidate in the collection's colours comes before the others
  (a green Ooze was offered for Grim Return, a Plains for Stitch Together,
  Canopy Surge for Clone). A confident off-colour match, a misfiled card,
  stays.
- **Searching to fix a card**: the printings of a searched name start with
  the set of the few cards just before it (binders are mostly sorted by set):
  after three Tenth Edition cards, a searched card's Tenth Edition printing
  comes first. The Zeta Set (a
  parody set) and playtest cards are left out of picture matching; search
  still finds them.
- **Printing tips** ("several printings look alike…", "…like the other cards
  on this page") show as a toast for a few seconds, with Don't show again.
- **Scan report** (each collection's ⋯ menu, **Share scan report**): for
  every card scanned into the collection, what the app read (its 5 closest
  matches and how close, the name it read, its flags) next to what was saved
  after the card check, whether you changed it, and the card's photo, as a zip
  (report.json + cards/*.jpg, about 20-30 KB a card). Every card fixed in the
  check is a real mistake to learn from; it's kept on the phone until shared,
  and deleted with the collection. The report keeps its own copies of the
  photos (a resumed scan's photos come from the autosave, which Safari ties
  to the autosave's file, deleted once the collection is saved: sharing then
  failed with "The object can not be found here"); a photo that can't be read
  is left out of the zip instead of failing it.
- **Export CSV** (a collection's ⋯ menu, or Export every card on the Search tab) opens the share sheet (Save
  to Files, Google Drive, …): name, set, collector number, finish, price,
  collection, page, slot and Scryfall ID of each card.
- Memory, for big binders (a crash at about 450 of 900 cards on an iPhone):
  the name strip of each card is kept as a small JPEG (not raw pixels) and
  dropped once read; each card keeps its 12 closest matches (not all of
  them); the name reader (Tesseract) is restarted every 120 reads, because its
  memory only grows; the pages aren't drawn under the card check, and their
  photos load as they're scrolled to.
- **Search** (tab bar) searches every collection ("do I own this?") with the
  same views and sorts, and lists matching cards you don't own yet.

## Screens and design

The interface follows the **MTGDB Design System** in Figma ("Obsidian and
gilt"): near-black surfaces, parchment text, one gold accent for actions and
focus, Fraunces for titles and card names and Inter for everything else
(loaded from Google Fonts, with system fallbacks offline). The colour and size
tokens in `src/ui/styles.css` use the same names as the Figma variables' code
syntax. Every control is at least 44 pt tall with a 3.5:1 outline and a
visible focus ring; `npm run ux` re-measures this.

- **Tab bar**: Collections, the raised gold **Scan** button, and Search.
- **Collections** (home): the portfolio total and its 30-day change, a tile
  per collection in its colour (chosen on the scan screen, or the colour most
  of its cards share) with its cover art, Worth selling now and Most
  valuable. The gear opens Settings.
- **A collection**: a header tinted with its colour and cover art, then its
  cards as a Gallery, a List or Art (each card's illustration). Choose cover
  art (any of its cards, with a search; the most valuable card until you
  pick one), Export, Share scan report and Delete are in the ⋯ menu.
- **Settings** (kept on the phone): the scan outline's colour (15 bright and
  colour-blind-safe colours; yellow by default), line weight and a contrast
  edge behind the lines; Dark, Light or Match phone theme; how collections
  open (Gallery, List or Art); the Worth selling now threshold (+10% to +50%);
  English cards only, Click sound and Faster photo import.
- **Uploading photos**: while the Photos app hands the photos over, the app
  shows Getting your photos… with a Cancel button. Safari converts each HEIC
  photo to JPEG first, which is most of the wait for dozens of photos;
  **Faster photo import** asks for the originals instead (iOS 17 or later
  opens HEIC). It's off by default because it hasn't been tried on every
  iPhone yet.
- **Card detail** (tap any card): its art fills the screen behind it; price
  and 30-day change, the price history recorded on this phone, where it lives
  (collection, page and slot, printing), its quantity and its finish, both of
  which can be changed. With more than one copy, it also shows what your
  copies are worth together.
- **Scan review**: Back keeps the scan as a draft to resume from the home
  screen; Discard scan and Share scan diagnostics are in its ⋯ menu.

## Prices and sell signals

- Prices are TCGplayer market prices in USD, via Scryfall, which updates them
  about once a day. The app refreshes prices for the cards you own from
  Scryfall's API automatically (at most twice a day), or right away with
  **Refresh prices**.
- **Worth selling now** lists cards trading at least 20% (set in Settings) and $1 above their
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
npm run ux -- https://mtgdb.vercel.app      # design audit: screenshot every screen at iPhone size, measure contrast, tap targets and text sizes
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
