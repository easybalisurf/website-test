# EasyBali.Surf — GitHub Pages (multi-file export)

`index.html` at repo root, with its data/runtime files alongside:
- `index.html` — the main booking site
- `surf-guide.html` — standalone wave/wind/swell/spots/seasonality guide, linked from Live Forecast
- `instructors.html` — instructor recruitment page (linked from the site footer, not in nav)
- `coming-soon.html` — placeholder page, e.g. to park on the domain before launch
- `support.js` — runtime the pages depend on
- `image-slot.js` — image component
- `i18n.js` — all site + booking-wizard copy, per language (edit to add a language or change text)
- `services-data.js` — pricing, transfer geo, surf-spot database (edit to add service packages / spots)

## Deploy
1. Push this folder's contents to the root of your GitHub repo (or the branch you deploy from).
2. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
3. Branch: your default branch, folder: **/ (root)**. Save.
4. Site publishes at `https://<username>.github.io/<repo>/`.

No build step — open `index.html` directly in a browser to preview locally too.
