# portal-builder

Local app to create and launch static Internet Archive portals (the `janapadavichara.sanchaya.net` pattern) on GitHub Pages.

## Run

    npm start        # http://localhost:4300   (Node 20+, no dependencies)

Needs `git` and an authenticated `gh` (`gh auth login`) on your machine.

## Flow

1. **New portal** — slug, title, tagline, subdomain, base domain, IA query (e.g. `collection:ServantsOfKnowledge AND identifier:jst.*`).
2. **Fetch items from IA** — builds the `issues.json` rows; edit titles/authors/years inline or remove rows. Re-fetching only appends new identifiers, so your edits stay.
3. **Preview** — renders the site into `workspace/<slug>` and opens it.
4. **Launch / Push** — commits, creates `<org>/<slug>` if missing, pushes `master` and `gh-pages`, enables Pages. The same button publishes later updates.
5. Add the DNS record shown under the buttons (`<sub> CNAME <org>.github.io.`) and enforce HTTPS in repo settings once it resolves.

Commits use `GIT_NAME` / `GIT_EMAIL` (default Omshivaprakash <omshivaprakash@gmail.com>). `PORT` changes the port.

Project configs live in `data/projects.json`; generated sites in `workspace/`. Both are git-ignored.

`npm test` runs an offline self-check of the renderer.
