Nixpkgs PR tracker — browser version
===================================

Open index.html in a modern browser. No installation, build step, backend,
local Git checkout, or GitHub token is required. All requests go directly
to https://api.github.com. The app needs an internet connection.

Alternatively, serve this directory with any static file server. From the
repository root, for example:

    python3 -m http.server 8000 --directory js --bind 127.0.0.1

Then open http://localhost:8000. The server only serves files; all tracking
runs in the browser. The directory can also be hosted on GitHub Pages or
another static host without changes. Keep all files together, including
the source files and this README.md.

Usage
-----

Enter a PR number, #123, or a https://github.com/NixOS/nixpkgs/pull/123 URL.
The ?pr=123 query parameter loads a PR automatically and can be bookmarked
or shared on a static host. Submit again to check uncached branches; there
is no polling. Previously confirmed branches show "Included (cached)" with
a Refresh button that forces a new check for that branch.

The tree retains the branch routes and Hydra links from src/branches.rs,
including staging, haskell-updates, release branches, and older releases.
Open PRs show pending branches; closed, unmerged PRs show no release tree.
For merged PRs, the base branch is marked included, just as in the Rust
tracker. Each downstream branch is checked independently.

How it works
------------

GET /repos/NixOS/nixpkgs/pulls/{number} supplies the title, state, target
branch, and merge_commit_sha. For each uncached downstream branch the app requests:

    GET /repos/NixOS/nixpkgs/compare/{merge_commit_sha}...{branch}?per_page=1

An "ahead" or "identical" comparison means the branch contains the merge
commit. "Behind" or "diverged" means pending. This uses commit ancestry,
not the paginated list of commits, and replaces git branch --contains.
Requests run sequentially and results appear as they arrive. A merged PR
targeting master needs up to four API requests; one targeting staging needs up to six.
Open and closed, unmerged PRs need only one.

Positive downstream results are saved in first-party cookies for one year,
keyed by PR number, merge commit, and branch. Cached branches skip the
comparison request. PR metadata is always fetched, so the base branch's
merge status stays fresh. Pending and unknown results are never cached.
Refresh discards that branch's saved result before checking again, while
other confirmed branches still use the cache. If cookies are blocked or
unavailable (for example, when opened from disk), normal checks still work.

API failures, deleted branches, and missing or unreliable historical merge
commits show unknown progress, never a false pending result. One branch's
failure does not discard other results. Authentication/rate limit errors
stop further requests. A new lookup cancels the previous one.

Like the original tracker, this follows the merge commit's ancestry, not
equivalent cherry-picks or reverts, and does not verify Hydra build success
or independently check the published channel artifacts. Branches can move
during a lookup. GitHub comparisons of very old commits can time out; the
app stops each request after 30 seconds and shows the result as unknown.
Unknown branch routes appear as a single base branch.

Authentication and limits
-------------------------

Unauthenticated REST requests are limited to 60 per hour per IP. GitHub
usually allows 5,000 per hour with a personal access token. The page shows
the remaining quota and reset time reported by GitHub. Other applications
may share this quota; GitHub also applies secondary limits.

The optional password field accepts a personal access token for a higher
limit. Public repository access is sufficient; no write access is needed.
The app uses the token in an Authorization header to api.github.com and
saves it in a first-party cookie for up to one year, restoring it on page
load before any automatic lookup. Editing the field updates the saved
token; emptying it or using Clear removes the cookie. Clear also cancels
the active lookup.

The token cookie uses Secure and SameSite=Strict, is limited to this host,
and is also sent by the browser to the tracker host with eligible HTTPS
requests. It is accessible to this page's JavaScript. When cookies are
blocked or unavailable (including ordinary HTTP or file:// pages), the
token still works for the current page but may need to be entered again
after reloading. The token is never added to the URL.

GitHub API documentation:
https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request
https://docs.github.com/en/rest/commits/commits#compare-two-commits
https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests
https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api

Development
-----------

index.html   Page structure.
style.css    Responsive layout and light/dark themes.
tracker.js   Branch routing, input parsing, GitHub client, ancestry checks.
app.js       Form, URL, and tree rendering (uses textContent for API data).
test/        Deterministic tests using Node's built-in test runner.

Run tests from the repository root with Node.js 22 or newer:

    node --test js/test/*.test.js

The app uses browser fetch, AbortController, AbortSignal.any/timeout, and
classic scripts, so it works from disk as well as under a static host's
subdirectory. There are no third-party runtime or test dependencies.

License
-------

Derived from pr-tracker by Alyssa Ross and contributors. The branch rules
and historical merge-commit handling retain the original behavior.

SPDX-License-Identifier: AGPL-3.0-or-later WITH GPL-3.0-linking-exception
See [LICENSE](LICENSE) for the full license and linking exception texts.
The JavaScript and HTML/CSS files served alongside this README.md are the
complete, unbundled source of this browser application.
