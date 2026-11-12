# portal-builder

A [Servants of Knowledge](https://archive.org/details/ServantsOfKnowledge) product.

Local app to create and launch static Internet Archive portals (the `janapadavichara.sanchaya.net` pattern) on GitHub Pages.

## Run

    npm start        # http://localhost:4300   (Node 20+, no dependencies)

Needs `git` and an authenticated `gh` (`gh auth login`) on your machine.

## Flow

1. **New portal** — title, tagline, description, organization name/website, GitHub owner and new repo name, subdomain and base domain, logo, favicon, "see also" links, footer text, and whether items open in a **new tab** (default) or an **in-page frame**. Items come from an IA query (e.g. `collection:ServantsOfKnowledge AND identifier:jst.*`).
2. **Fetch items from IA** — builds the `issues.json` rows; edit titles/authors/years inline or remove rows. Re-fetching only appends new identifiers, so your edits stay.
3. **Preview locally** — renders the site into `workspace/<slug>` and opens it from this app (`/preview/<slug>/`). Nothing is pushed until you click Launch.
4. **Launch / Push** — commits, creates `<owner>/<repo>` if missing, pushes `master` and `gh-pages`, enables Pages. The same button publishes later updates.
5. Add the DNS record shown under the buttons (`<sub> CNAME <owner>.github.io.`) and enforce HTTPS in repo settings once it resolves.

Commits use `GIT_NAME` / `GIT_EMAIL` (default Omshivaprakash <omshivaprakash@gmail.com>). `PORT` changes the port.

Project configs live in `data/projects.json`; generated sites in `workspace/`. Both are git-ignored.

`npm test` runs an offline self-check of the renderer.

## Host on Coolify

1. New Resource → Docker Compose, pick this repo (add a deploy key if it is private).
2. Coolify flags `GH_TOKEN`: paste a GitHub token with `repo` scope (plus `workflow` if you ever push workflow files) that can create repos under the owners you publish to.
3. Set the domain Coolify offers for `portal-builder` (port 4300). It generates the login password: **Environment Variables → `SERVICE_PASSWORD_PORTALBUILDER`**. The username is `ADMIN_USER` (default `admin`).
4. Deploy. Project configs and generated sites persist in the `portal-data` and `portal-workspace` volumes.

The server refuses to start on a public address without a password, and every request needs HTTP Basic auth (use HTTPS, which Coolify's proxy provides). `GIT_NAME` / `GIT_EMAIL` set the commit identity. Docker without Coolify: `ADMIN_PASSWORD=… GH_TOKEN=… docker compose up --build` after replacing the `SERVICE_*` lines.

## Logo

Place the Servants of Knowledge logo at `template/img/sok-logo.png` (portals) and `public/sok-logo.png` (this app). Without the files, only the name is shown.
