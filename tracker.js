// SPDX-License-Identifier: AGPL-3.0-or-later WITH GPL-3.0-linking-exception
// SPDX-FileCopyrightText: 2021, 2023, 2024 Alyssa Ross <hi@alyssa.is>
// SPDX-FileCopyrightText: 2022 Arnout Engelen <arnout@bzzt.net>

"use strict";

// A classic script so index.html also works when opened directly from disk.
(() => {
  const repository = "https://github.com/NixOS/nixpkgs";
  const api = "https://api.github.com/repos/NixOS/nixpkgs";

  // Keep these routes and Hydra links in sync with src/branches.rs.
  const routes = [
    [/^staging$/, "staging-next"],
    [/^staging-next$/, "master"],
    [/^staging-next-([\d.]+)$/, "release-$1"],
    [/^haskell-updates$/, "staging"],
    [/^master$/, "nixpkgs-unstable"],
    [/^master$/, "nixos-unstable-small"],
    [/^nixos-(.*)-small$/, "nixos-$1"],
    [/^release-([\d.]+)$/, "nixpkgs-$1-darwin"],
    [/^release-([\d.]+)$/, "nixos-$1-small"],
    [/^staging-((1.|20)\.\d{2})$/, "release-$1"],
    [/^staging-((2[1-9]|[3-90].)\.\d{2})$/, "staging-next-$1"],
    [/^staging-nixos$/, "master"],
  ];
  const hydraRoutes = [
    [/^staging-next$/, "jobset/nixpkgs/staging-next#tabs-jobs"],
    [/^staging-next-([013-9]\d\.\d{2}|2(1\.05|[2-90]\.\d{2}))$/,
      "jobset/nixpkgs/staging-next-$1#tabs-jobs"],
    [/^haskell-updates$/, "jobset/nixpkgs/haskell-updates#tabs-jobs"],
    [/^master$/, "jobset/nixpkgs/trunk#tabs-jobs"],
    [/^nixpkgs-unstable$/, "job/nixpkgs/trunk/unstable#tabs-constituents"],
    [/^nixos-unstable-small$/, "job/nixos/unstable-small/tested#tabs-constituents"],
    [/^nixos-unstable$/, "job/nixos/trunk-combined/tested#tabs-constituents"],
    [/^nixos-(\d.*)$/, "job/nixos/release-$1/tested#tabs-constituents"],
  ];

  function parsePR(input) {
    const value = input.trim();
    let number = value.match(/^#?(\d+)$/)?.[1];
    if (!number) {
      try {
        const url = new URL(value);
        if (url.protocol === "https:" && url.host === "github.com" &&
            !url.username && !url.password) {
          number = url.pathname.match(
            /^\/NixOS\/nixpkgs\/pull\/(\d+)(?:\/(?:files|commits|checks))?\/?$/i,
          )?.[1];
        }
      } catch { /* Show the same helpful error for all invalid inputs. */ }
    }
    if (!number || !Number.isSafeInteger(Number(number)) || Number(number) < 1) {
      throw new Error("Enter a positive PR number, #123, or a NixOS/nixpkgs pull request URL.");
    }
    return Number(number);
  }

  function nextBranches(branch) {
    return routes.filter(([pattern]) => pattern.test(branch))
      .map(([pattern, replacement]) => branch.replace(pattern, replacement));
  }

  function hydraLink(branch) {
    const route = hydraRoutes.find(([pattern]) => pattern.test(branch));
    return route ? `https://hydra.nixos.org/${branch.replace(...route)}` : null;
  }

  function makeTree(branch, state) {
    return {
      branch, state, cached: false, detail: "", hydra: hydraLink(branch),
      children: nextBranches(branch).map(next => makeTree(next, state)),
    };
  }

  function flattenTree(tree) {
    return [tree, ...tree.children.flatMap(flattenTree)];
  }

  function comparisonState(status) {
    // BASE is the merge commit, HEAD is the channel branch. Only ahead and
    // identical prove that the merge commit is an ancestor of HEAD.
    if (status === "ahead" || status === "identical") return "accepted";
    if (status === "behind" || status === "diverged") return "pending";
    throw new Error("GitHub returned an unrecognized comparison result.");
  }

  function createInclusionCache(cookieDocument = globalThis.document) {
    const cookieName = number => `nixpkgs-pr-included-v1-${number}`;

    function read(number, mergeCommit) {
      try {
        const prefix = `${cookieName(number)}=`;
        const cookie = cookieDocument.cookie.split(";").map(value => value.trim())
          .find(value => value.startsWith(prefix));
        if (cookie) {
          const data = JSON.parse(decodeURIComponent(cookie.slice(prefix.length)));
          if (data.mergeCommit === mergeCommit && Array.isArray(data.branches) &&
              data.branches.every(branch => typeof branch === "string")) {
            return new Set(data.branches);
          }
        }
      } catch { /* Missing, malformed, or blocked cookies are cache misses. */ }
      return new Set();
    }

    function write(number, mergeCommit, branches) {
      try {
        const value = encodeURIComponent(JSON.stringify({ mergeCommit, branches: [...branches] }));
        const secure = cookieDocument.location?.protocol === "https:" ? "; Secure" : "";
        cookieDocument.cookie = `${cookieName(number)}=${value}; Path=/; ` +
          `Max-Age=${branches.size ? 31536000 : 0}; SameSite=Lax${secure}`;
      } catch { /* Tracking still works when cookies are unavailable, including file://. */ }
    }

    return {
      has(number, mergeCommit, branch) { return read(number, mergeCommit).has(branch); },
      add(number, mergeCommit, branch) {
        const branches = read(number, mergeCommit);
        branches.add(branch);
        write(number, mergeCommit, branches);
      },
      delete(number, mergeCommit, branch) {
        const branches = read(number, mergeCommit);
        branches.delete(branch);
        write(number, mergeCommit, branches);
      },
    };
  }

  function createTokenStore(cookieDocument = globalThis.document) {
    const name = "nixpkgs-pr-token-v1";
    return {
      load() {
        try {
          const prefix = `${name}=`;
          const cookie = cookieDocument.cookie.split(";").map(value => value.trim())
            .find(value => value.startsWith(prefix));
          if (cookie) return decodeURIComponent(cookie.slice(prefix.length)).trim();
        } catch { /* Missing, malformed, or blocked cookies leave the token empty. */ }
        return "";
      },
      save(token) {
        try {
          const value = token.trim();
          // Always Secure: a saved credential must not travel over plain HTTP.
          cookieDocument.cookie = `${name}=${encodeURIComponent(value)}; Path=/; ` +
            `Max-Age=${value ? 31536000 : 0}; SameSite=Strict; Secure`;
        } catch { /* The token can still be used for this page when storage is unavailable. */ }
      },
    };
  }

  class GitHubError extends Error {
    constructor(message, status) {
      super(message);
      this.name = "GitHubError";
      this.status = status;
    }
  }

  function createClient({ token = "", signal, onRateLimit = () => {}, fetchImpl = fetch } = {}) {
    return async path => {
      const headers = { Accept: "application/vnd.github+json" };
      if (token.trim()) headers.Authorization = `Bearer ${token.trim()}`;
      let response;
      let data;
      try {
        response = await fetchImpl(`${api}${path}`, {
          headers,
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]),
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
        });
        onRateLimit({
          remaining: response.headers.get("x-ratelimit-remaining"),
          limit: response.headers.get("x-ratelimit-limit"),
          reset: response.headers.get("x-ratelimit-reset"),
        });
        data = await response.json();
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error.name === "TimeoutError") {
          throw new Error("GitHub took too long to respond. Try tracking this PR again.");
        }
        if (!response) {
          throw new Error("Could not reach GitHub. Check your connection and try again.");
        }
        // A non-JSON error response must still retain its HTTP status below.
        if (response.ok) throw new Error("GitHub returned an unreadable response. Try again.");
      }
      if (!response.ok) {
        let message = `GitHub request failed (HTTP ${response.status}). Try again later.`;
        if (response.status === 401) {
          message = "GitHub rejected the token. Clear it to continue without authentication, or enter a valid token.";
        } else if (response.status === 429 || (response.status === 403 && (
          response.headers.get("x-ratelimit-remaining") === "0" ||
          /rate limit/i.test(data?.message || "")
        ))) {
          const reset = Number(response.headers.get("x-ratelimit-reset"));
          const when = reset ? ` after ${new Date(reset * 1000).toLocaleTimeString()}` : " later";
          message = `GitHub's rate limit was reached. Try again${when}, or use an optional token for a higher limit.`;
        } else if (response.status === 403) {
          message = "GitHub denied this request. Check the token's access or try again later.";
        } else if (response.status === 404) {
          message = path.startsWith("/pulls/")
            ? "No such NixOS/nixpkgs pull request. Check the PR number."
            : "GitHub could not compare this branch and merge commit. The branch or commit may no longer exist.";
        }
        throw new GitHubError(message, response.status);
      }
      return data;
    };
  }

  async function trackPR(number, { request, signal, cache, forceBranch, onUpdate = () => {} }) {
    number = parsePR(String(number));
    const pr = await request(`/pulls/${number}`);
    signal?.throwIfAborted();
    const state = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    const result = { pr, state, tree: null, warning: "", complete: false };
    if (state === "closed") {
      result.complete = true;
      onUpdate(result);
      return result;
    }

    const tree = makeTree(pr.base.ref, state === "merged" ? "checking" : "pending");
    result.tree = tree;
    if (state === "open") {
      result.complete = true;
      onUpdate(result);
      return result;
    }

    // Match the original tracker: GitHub's merged status establishes the base
    // branch even when its ref was deleted or no merge SHA is available.
    tree.state = "accepted";
    tree.detail = "Merged into this branch.";
    const descendants = flattenTree(tree).slice(1);
    // GitHub reported synthetic merge commits for the oldest PRs.
    const mergeCommit = pr.merged_at && pr.merged_at >= "2013-10-20T15:50:06Z"
      ? pr.merge_commit_sha : null;
    if (!mergeCommit) {
      result.warning = "GitHub does not provide a reliable merge commit for this PR, so its progress beyond the base branch is unknown.";
      descendants.forEach(node => { node.state = "unknown"; });
    } else {
      for (const node of descendants) {
        if (node.branch === forceBranch) {
          // Remove the old result before checking so failures or cancellation
          // cannot leave a stale positive result for the next lookup.
          cache?.delete(number, mergeCommit, node.branch);
        } else if (cache?.has(number, mergeCommit, node.branch)) {
          node.state = "accepted";
          node.cached = true;
        }
      }
      onUpdate(result);
      let stoppedError;
      // Small, sequential requests avoid bursts and preserve partial results.
      for (const node of descendants) {
        signal?.throwIfAborted();
        if (node.cached) continue;
        try {
          if (stoppedError) throw stoppedError;
          const comparison = await request(
            `/compare/${encodeURIComponent(mergeCommit)}...${encodeURIComponent(node.branch)}?per_page=1`,
          );
          signal?.throwIfAborted();
          node.state = comparisonState(comparison.status);
          if (node.state === "accepted") cache?.add(number, mergeCommit, node.branch);
        } catch (error) {
          if (signal?.aborted || error.name === "AbortError") throw error;
          node.state = "unknown";
          node.detail = error.message;
          // Authentication and rate limit failures affect every remaining branch.
          if ([401, 403, 429].includes(error.status)) stoppedError = error;
        }
        onUpdate(result);
      }
    }
    result.complete = true;
    onUpdate(result);
    return result;
  }

  globalThis.PRTracker = Object.freeze({
    repository, parsePR, nextBranches, hydraLink, flattenTree,
    comparisonState, createInclusionCache, createTokenStore, createClient, trackPR, GitHubError,
  });
})();
