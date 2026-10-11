# Playbook clips

These are the stock clips that `harness/playbook.py` cites in each habit's `clip.uri` and `source`. The method is clip-first (project record, "The clips"): the footage was chosen first, and each habit's text was then written to describe what the clip actually shows, so nobody has to film anything and nobody overclaims.

All six clips come from Pexels and carry the **Pexels License** (https://www.pexels.com/license/): free to use for commercial and non-commercial purposes, no attribution required (we credit anyway), no resale as-is, no use for AI training. Video bytes are not stored in MongoDB; the playbook document holds the direct mp4 URL plus `t0`/`t1` in seconds.

## Verification (2026-10-11)

Every direct `.mp4` URL below returned `HTTP/2 200` to `curl -sIL`, and `ffprobe` read the duration remotely. The HTML page URLs are behind Cloudflare and return 403 to `curl` and other non-browser clients; they load normally in a browser, and the metadata here (title, author, description) was read through the `r.jina.ai` reader proxy, which returned 200 for each page.

## The clips

| # | Habit | Title | Author | Page URL | Direct mp4 | Length |
|---|-------|-------|--------|----------|------------|--------|
| 1 | `habit:stairs-when-lift-busy` | Man Walking in an Office Building | Fnesan | https://www.pexels.com/video/man-walking-in-an-office-building-12820607/ | https://videos.pexels.com/video-files/12820607/12820607-uhd_2560_1440_25fps.mp4 | 8.2 s |
| 2 | `habit:empty-handed-on-stairs` | A Man Climbing the Stairs | Pat Whelen | https://www.pexels.com/video/a-man-climbing-the-stairs-5658034/ | https://videos.pexels.com/video-files/5658034/5658034-hd_1920_1080_24fps.mp4 | 12.4 s |
| 3 | `habit:slow-near-blind-corner` | Man Working inside the Warehouse | Tiger Lily | https://www.pexels.com/video/man-working-inside-the-warehouse-4292299/ | https://videos.pexels.com/video-files/4292299/4292299-uhd_2560_1440_25fps.mp4 | 8.8 s |
| 4 | `habit:back-off-head-on` | Man Waiting In Front of a Door | MART PRODUCTION | https://www.pexels.com/video/man-waiting-in-front-of-a-door-7701955/ | https://videos.pexels.com/video-files/7701955/7701955-uhd_2732_1440_25fps.mp4 | 21.1 s |
| 5 | `habit:clear-nearby-shelves-first` | A Warehouseman Getting Boxes from the Storage Using Shopping Cart | cottonbro studio | https://www.pexels.com/video/a-warehouseman-getting-boxes-from-the-storage-using-shopping-cart-7019236/ | https://videos.pexels.com/video-files/7019236/7019236-uhd_2732_1440_25fps.mp4 | 52.3 s |
| 6 | `habit:yield-to-loaded-forklift` | Video Footage Of Hardware Warehouse | Luday Leguen | https://www.pexels.com/video/video-footage-of-hardware-warehouse-4727768/ | https://videos.pexels.com/video-files/4727768/4727768-hd_1920_1080_30fps.mp4 | 43.4 s |

Pexels' own one-line descriptions, which the habit texts were written against:

1. "A silhouette of a person walking in a modern office interior with staircase."
2. "Man climbs urban stairs with a backpack, low angle view outdoors."
3. "A man in a beanie carries a box down a warehouse aisle, surrounded by shelves and inventory."
4. "A food delivery courier waiting in a hallway with a yellow thermal bag."
5. "Man in beanie organizing boxes on warehouse shelves."
6. "Men operating forklifts in a warehouse moving wood and inventory."

## Honest limits

Clip 2 is an outdoor staircase, not a warehouse stairwell; the habit only claims that the climber's hands are free. Clip 4 shows a courier waiting at a hallway door, not a lift lobby; the habit only claims that he waits to one side rather than pushing through. Clip 6 shows forklifts moving timber with workers nearby; it carries the `yielding` habit, which has no setting to map to and is recorded as the capability gap. If better footage turns up (a lift lobby with a queue, or a worker visibly stepping aside for a forklift), swap the `clip` and `source` fields in `harness/playbook.py` and re-run `harness/.venv/bin/python -m harness.playbook`; the seed is idempotent.

## Alternates checked and not used

- https://www.pexels.com/video/man-lifting-boxes-inside-the-warehouse-4292580/ (Tiger Lily, 34 MB mp4) — similar to clip 3.
- https://www.pexels.com/video/men-working-inside-the-warehouse-4292579/ (Tiger Lily) — two workers moving boxes; weaker for yielding.
- https://www.pexels.com/video/woman-entering-a-elevator-8453075/ (cottonbro studio) — people inside a lift; shows riding, not waiting.
