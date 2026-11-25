## What

Feature pages (and the homepage introduction) now play the walkthrough inline instead of sending viewers off-site.

`FeatureVideo` derives a provider from the stored URL, and one shared partial renders it:

| URL shape | Rendered |
|---|---|
| `youtu.be/<id>`, `youtube.com/watch?v=`, `/embed/<id>`, `/shorts/<id>` (with `t=` / `start=`) | `<iframe src="https://www.youtube-nocookie.com/embed/<id>?rel=0&playsinline=1&start=N">` |
| `joomdeck.com/r/<slug>`, `/r/<slug>/video`, `/r/<slug>/embed` | `<iframe src="https://joomdeck.com/r/<slug>/embed" width="960" height="540" frameborder="0" allowfullscreen loading="lazy">` |
| `.mp4` / `.webm` | `<video controls preload="metadata">` (unchanged) |
| anything else HTTPS | existing outbound watch-page button |

No migration: the stored URL stays the source of truth; provider, provider id and embed URL are derived.

## Also

- `site/app/views/pages/_video_player.html.erb` replaces the duplicated regex branch in `feature.html.erb` and `index.html.erb`.
- Admin shows the detected provider next to each field (`JoomDeck - cngsujjbbn`, `YouTube - <id>`, `MP4 file`, `External link`) and the validation message names every accepted URL form.
- CSS keeps embeds inside `.video-panel` / `.intro-video` at 16:9.
- Tests cover every URL shape plus rendered markup: YouTube renders a nocookie iframe and no `<video>`, JoomDeck renders the `/embed` iframe, unknown HTTPS still renders the button, and the existing mp4 assertion is unchanged.

## Verification

Local ruby is unavailable on the authoring host, so the site suite runs in CI (`docs-site.yml`). This is a draft until that run is green on this head.
