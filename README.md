# THD Space

Client presentations for THD Studio (interior design, Cairo), the team hub, and the admin
panel that manages them. The full technical reference is [CLAUDE.md](CLAUDE.md); this page is
the short version.

## What is here

| Folder | What it is |
|---|---|
| `engine/` | The presentation app every client project shares (plain JS, no build) |
| `hub/` | "THD Space", the team's installable app: the list of projects |
| `admin/` | The admin panel: projects, uploads, publishing, templates |
| `functions/` + `server/` | Cloudflare Pages Functions: serve projects from the bucket, admin API |
| `projects/` | Generated projects made from folders (the original workflow; still works on a static host) |
| `tools/` | Node scripts: build `dist/`, import a folder project into the bucket, image helpers |

## Run the lab (local, nothing leaves your machine)

Needs Node 18+. Once: `npm install`. Then:

```
npm run dev
```

Wrangler serves the site at http://localhost:8788 with an emulated bucket under `.wrangler/state/`
(it persists between runs). Then:

- http://localhost:8788/hub/ — the team hub
- http://localhost:8788/admin/ — the admin panel (no sign-in locally)
- http://localhost:8788/projects/inas-el-baily-villa/ — a presentation

To put the villa (or any generated project folder) into the local bucket:

```
node tools/import-project.js projects/inas-el-baily-villa
```

After editing files in `admin/`, `hub/` or `engine/`, run `npm run build` (or restart `npm run dev`)
to refresh `dist/`. Functions and `server/` reload on their own. Tests: `npm test`.

## Deploy

Cloudflare Pages + R2, free tier. Steps are in CLAUDE.md under "Deploying".
