# Runner – deploy notes

Runner is a static site (no server code). iPhone needs it on **HTTPS** to keep the
service worker and "Add to Home Screen" behaviour. Upload the contents of `dist/`
(or `zip-runner-dist.zip`) to any free static host:

## Option 1 – Netlify Drop (fastest, no git)
1. On any browser, open https://app.netlify.com/drop (free account needed to keep the site).
2. Drag the unzipped `dist` folder onto the page.
3. You get `https://<random-name>.netlify.app` – open it in Safari on the iPhone.
   (`_headers` in the folder makes `sw.js` revalidate on every load.)

## Option 2 – Cloudflare Pages (direct upload)
1. dash.cloudflare.com → Workers & Pages → Create → Pages → "Upload assets".
2. Name the project, upload `zip-runner-dist.zip` (or the folder).
3. Site is at `https://<project>.pages.dev`. `_headers` is honoured here too.

## Option 3 – GitHub Pages
1. Create a repo (e.g. `runner`), add the files from `dist/` at the repo root, push.
2. Repo Settings → Pages → Source: "Deploy from a branch" → `main` / `(root)`.
3. Site is at `https://<user>.github.io/runner/`. Runner works from a sub-path
   (all URLs are relative; tested at `/app/`). `.nojekyll` is included.
   Note: GitHub Pages ignores `_headers`; after updating Runner, fully close and
   reopen the app once or twice to pick up the new version.

## Install on iPhone
Safari → open the URL → Share button → **Add to Home Screen** → open "Runner" from
the Home Screen (open it from there, not from a Safari tab, so its storage is the
installed app's storage).

## Updating Runner itself
Bump `VERSION` in `sw.js` when you change app files, then redeploy. The app shell
is served stale-while-revalidate, so the new version shows on the next launch.
Imported projects and saves live in the browser's storage and are not affected by
redeploys – but they are tied to the exact origin (domain). Moving to a new domain
means re-importing projects and restoring saves from exported JSON.
