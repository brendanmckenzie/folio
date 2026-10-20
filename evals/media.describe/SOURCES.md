# media.describe fixtures

Ten photographs from Wikimedia Commons, every one released under CC0 1.0 (the licence is read from
each file page's metadata, 2026-10-20). Folio is a public repository, so nothing else belongs here:
no client photographs and no images of identifiable people.

Each `cases/<case>/image.webp` is the Commons 512px thumbnail re-encoded as WebP (quality 72), which
is what Folio sends when an Images binding exists. The same list, with licences, is in `suite.json`.

| Case | What it exercises | Source | Author | Licence |
|---|---|---|---|---|
| dog | one animal, simple tags | https://commons.wikimedia.org/wiki/File:Dog_park,_small_dog_mix.jpg | Kurt Kaiser | CC0 1.0 |
| market | a scene with several applicable tags | https://commons.wikimedia.org/wiki/File:Street_market_inthe_Rocks_district_of_Sydney.jpg | Commons uploader ("Returned dude12345") | CC0 1.0 |
| noodles | food, one tag | https://commons.wikimedia.org/wiki/File:Noodle_soup_in_Asia_Bowl_2025-07-26.jpg | Andy Li | CC0 1.0 |
| lake | landscape, four tags, two facts | https://commons.wikimedia.org/wiki/File:Mountain_lake_(Unsplash).jpg | Aleksandra Boguslawska | CC0 1.0 |
| bicycle | a vocabulary with no applicable tag (must answer `[]`) | https://commons.wikimedia.org/wiki/File:Green_bicycle_leaning_on_the_wall.jpg | www.Pixel.la Free Stock Photos | CC0 1.0 |
| kingfisher | wildlife, two facts | https://commons.wikimedia.org/wiki/File:Eisvogel_kingfisher.jpg | Frank-2.0 | CC0 1.0 |
| brick | architecture | https://commons.wikimedia.org/wiki/File:The-Handa-Red-Brick-Building-1.jpg | Evelyn-rose | CC0 1.0 |
| sign | legible text ("ONE WAY", "MADISON ST") | https://commons.wikimedia.org/wiki/File:One_Way_sign_Chicago.jpg | John M Wolfson | CC0 1.0 |
| texture | purely decorative (alt may be empty) | https://commons.wikimedia.org/wiki/File:Texture_15.JPG | Clara.Hoke | CC0 1.0 |
| kitchen | an empty vocabulary (must answer `[]`) | https://commons.wikimedia.org/wiki/File:Blue_white_kitchen_interior_(Unsplash).jpg | NeONBRAND | CC0 1.0 |

## Gold answers

`expected.json` per case:

- `tags`: the subset of the case's vocabulary (`input.json`) that genuinely applies.
- `mustMention`: fact groups. Each group is a list of acceptable words, and a group is met when any
  one of them appears in `alt` or `description`. Every group must be met.
- `decorative`: when true, alt text is not required.

A case passes when `tagF1 >= 0.6`, every fact group is met and the alt text is well formed (present
for a non-decorative image, one sentence, not opening "Image of" or "Photo of"). The suite metric is
the pass rate; the gate tolerance is one case in ten.
