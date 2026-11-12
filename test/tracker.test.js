// SPDX-License-Identifier: AGPL-3.0-or-later WITH GPL-3.0-linking-exception
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
require("../tracker.js");
const {
  parsePR, nextBranches, hydraLink, flattenTree, comparisonState,
  createInclusionCache, createTokenStore, createClient, trackPR, GitHubError,
} = globalThis.PRTracker;

const mergedPR = {
  number: 123, title: "A package update", state: "closed", merged: true,
  merged_at: "2026-01-01T12:00:00Z", merge_commit_sha: "abcdef",
  base: { ref: "master" },
};

function fixture(pr = mergedPR, comparisons = ["ahead", "behind", "diverged"]) {
  const calls = [];
  return {
    calls,
    async request(path) {
      calls.push(path);
      if (path.startsWith("/pulls/")) return pr;
      const response = comparisons[calls.length - 2];
      if (response instanceof Error) throw response;
      return { status: response };
    },
  };
}

function cookieDocument() {
  const cookies = new Map();
  const writes = [];
  return {
    writes,
    location: { protocol: "https:" },
    get cookie() { return [...cookies].map(([name, value]) => `${name}=${value}`).join("; "); },
    set cookie(cookie) {
      writes.push(cookie);
      const [pair, ...attributes] = cookie.split("; ");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      if (attributes.includes("Max-Age=0")) cookies.delete(name);
      else cookies.set(name, pair.slice(separator + 1));
    },
  };
}

test("accepts numbers, hashes, and Nixpkgs PR URLs", () => {
  for (const input of ["123", " #123 ", "00123",
    "https://github.com/NixOS/nixpkgs/pull/123",
    "https://github.com/nixos/nixpkgs/pull/123/?foo=bar#discussion",
    "https://github.com/NixOS/nixpkgs/pull/123/files#diff-abc",
  ]) assert.equal(parsePR(input), 123);
});

test("rejects invalid numbers and URLs from other repositories before making a request", async () => {
  for (const input of ["", "0", "-1", "1.5", "1e3", "foo123", "123abc", "9007199254740993",
    "https://example.com/NixOS/nixpkgs/pull/123",
    "https://github.com/other/nixpkgs/pull/123",
    "https://github.com/NixOS/nixpkgs/issues/123",
    "https://github.com/NixOS/nixpkgs/pull/123/files/456",
    "https://user:password@github.com/NixOS/nixpkgs/pull/123",
  ]) assert.throws(() => parsePR(input), /Enter a positive PR number/);
  const client = fixture();
  await assert.rejects(trackPR(0, client), /Enter a positive PR number/);
  assert.equal(client.calls.length, 0);
});

test("preserves current and historical branch routes from the Rust tracker", () => {
  const cases = {
    "haskell-updates": ["staging"],
    staging: ["staging-next"],
    "staging-next": ["master"],
    "staging-nixos": ["master"],
    master: ["nixpkgs-unstable", "nixos-unstable-small"],
    "nixos-unstable-small": ["nixos-unstable"],
    "nixos-unstable": [],
    "nixpkgs-unstable": [],
    "staging-18.03": ["release-18.03"],
    "staging-20.09": ["release-20.09"],
    "staging-21.05": ["staging-next-21.05"],
    "staging-30.05": ["staging-next-30.05"],
    "staging-00.11": ["staging-next-00.11"],
    "staging-next-21.11": ["release-21.11"],
    "release-26.05": ["nixpkgs-26.05-darwin", "nixos-26.05-small"],
    "nixos-26.05-small": ["nixos-26.05"],
    "nixos-26.05": [],
    "unknown/branch": [],
  };
  for (const [branch, expected] of Object.entries(cases)) {
    assert.deepEqual(nextBranches(branch), expected, branch);
  }
});

test("preserves Hydra jobsets, channel jobs, and the 21.11 exception", () => {
  assert.equal(hydraLink("master"), "https://hydra.nixos.org/jobset/nixpkgs/trunk#tabs-jobs");
  assert.equal(hydraLink("staging-next"), "https://hydra.nixos.org/jobset/nixpkgs/staging-next#tabs-jobs");
  assert.equal(hydraLink("haskell-updates"), "https://hydra.nixos.org/jobset/nixpkgs/haskell-updates#tabs-jobs");
  for (const version of ["21.05", "22.05", "30.05"]) {
    assert.equal(hydraLink(`staging-next-${version}`),
      `https://hydra.nixos.org/jobset/nixpkgs/staging-next-${version}#tabs-jobs`);
  }
  assert.equal(hydraLink("nixpkgs-unstable"), "https://hydra.nixos.org/job/nixpkgs/trunk/unstable#tabs-constituents");
  assert.equal(hydraLink("nixos-unstable-small"), "https://hydra.nixos.org/job/nixos/unstable-small/tested#tabs-constituents");
  assert.equal(hydraLink("nixos-unstable"), "https://hydra.nixos.org/job/nixos/trunk-combined/tested#tabs-constituents");
  assert.equal(hydraLink("nixos-26.05-small"), "https://hydra.nixos.org/job/nixos/release-26.05-small/tested#tabs-constituents");
  assert.equal(hydraLink("staging-next-21.11"), null);
  assert.equal(hydraLink("staging-18.03"), null);
});

test("uses comparison ancestry, never a truncated commits list", () => {
  assert.equal(comparisonState("ahead"), "accepted");
  assert.equal(comparisonState("identical"), "accepted");
  assert.equal(comparisonState("behind"), "pending");
  assert.equal(comparisonState("diverged"), "pending");
  assert.throws(() => comparisonState(undefined), /unrecognized comparison/);
});

test("merged PRs query each descendant independently and stream partial results", async () => {
  const client = fixture(mergedPR, ["identical", "behind", "ahead"]);
  const updates = [];
  const result = await trackPR(123, {
    ...client, onUpdate: result => updates.push(structuredClone(result)),
  });
  assert.deepEqual(client.calls, [
    "/pulls/123",
    "/compare/abcdef...nixpkgs-unstable?per_page=1",
    "/compare/abcdef...nixos-unstable-small?per_page=1",
    "/compare/abcdef...nixos-unstable?per_page=1",
  ]);
  assert.deepEqual(flattenTree(result.tree).map(n => n.state),
    ["accepted", "accepted", "pending", "accepted"]);
  assert.equal(updates[0].tree.children[0].state, "checking");
  assert.equal(updates[1].tree.children[0].state, "accepted");
  assert.equal(updates.at(-1).complete, true);
});

test("positive results persist in cookies and skip comparisons on a later visit", async () => {
  const document = cookieDocument();
  const first = fixture(mergedPR, ["ahead", "identical", "ahead"]);
  const fresh = await trackPR(123, { ...first, cache: createInclusionCache(document) });
  assert.ok(flattenTree(fresh.tree).every(node => node.state === "accepted" && !node.cached));
  assert.match(document.writes.at(-1), /; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/);

  const second = fixture();
  const cached = await trackPR(123, { ...second, cache: createInclusionCache(document) });
  assert.deepEqual(second.calls, ["/pulls/123"]);
  assert.deepEqual(flattenTree(cached.tree).map(node => node.cached), [false, true, true, true]);
  assert.ok(flattenTree(cached.tree).every(node => node.state === "accepted"));
  assert.equal(cached.complete, true);
});

test("pending and unknown branches are checked again while positive branches use cookies", async () => {
  const cache = createInclusionCache(cookieDocument());
  await trackPR(123, {
    ...fixture(mergedPR, ["ahead", "behind", new GitHubError("Unavailable", 503)]), cache,
  });
  const client = fixture(mergedPR, ["identical", "ahead"]);
  const result = await trackPR(123, { ...client, cache });
  assert.deepEqual(client.calls, [
    "/pulls/123",
    "/compare/abcdef...nixos-unstable-small?per_page=1",
    "/compare/abcdef...nixos-unstable?per_page=1",
  ]);
  assert.deepEqual(flattenTree(result.tree).map(node => node.cached), [false, true, false, false]);
  assert.ok(flattenTree(result.tree).every(node => node.state === "accepted"));
});

test("cached inclusion is isolated by PR number, merge commit, and branch", async () => {
  const cache = createInclusionCache(cookieDocument());
  cache.add(123, "abcdef", "nixpkgs-unstable");
  assert.equal(cache.has(123, "abcdef", "nixpkgs-unstable"), true);
  assert.equal(cache.has(124, "abcdef", "nixpkgs-unstable"), false);
  assert.equal(cache.has(123, "abcdef", "nixos-unstable"), false);
  assert.equal(cache.has(123, "new-merge", "nixpkgs-unstable"), false);

  for (const pr of [{ ...mergedPR, number: 124 }, { ...mergedPR, merge_commit_sha: "new-merge" }]) {
    const client = fixture(pr, ["behind", "behind", "behind"]);
    const result = await trackPR(pr.number, { ...client, cache });
    assert.equal(client.calls.length, 4);
    assert.ok(flattenTree(result.tree).every(node => !node.cached));
  }
});

test("refresh bypasses the selected branch's cookie and replaces or removes its result", async () => {
  for (const response of ["ahead", "behind", new GitHubError("Unavailable", 503)]) {
    const cache = createInclusionCache(cookieDocument());
    await trackPR(123, { ...fixture(mergedPR, ["ahead", "ahead", "ahead"]), cache });
    const client = fixture(mergedPR, [response]);
    const result = await trackPR(123, { ...client, cache, forceBranch: "nixos-unstable-small" });
    assert.deepEqual(client.calls, ["/pulls/123", "/compare/abcdef...nixos-unstable-small?per_page=1"]);
    const node = result.tree.children[1];
    assert.equal(node.cached, false);
    assert.equal(node.state, response === "ahead" ? "accepted" : response === "behind" ? "pending" : "unknown");
    assert.equal(cache.has(123, "abcdef", node.branch), response === "ahead");
    assert.equal(result.tree.children[0].cached, true);
    assert.equal(node.children[0].cached, true);
  }
});

test("cancelled refreshes do not leave stale inclusion in cookies", async () => {
  const cache = createInclusionCache(cookieDocument());
  cache.add(123, "abcdef", "nixpkgs-unstable");
  const controller = new AbortController();
  const client = fixture();
  await assert.rejects(trackPR(123, {
    ...client, cache, forceBranch: "nixpkgs-unstable", signal: controller.signal,
    onUpdate() { controller.abort(); },
  }), { name: "AbortError" });
  assert.equal(cache.has(123, "abcdef", "nixpkgs-unstable"), false);
  assert.deepEqual(client.calls, ["/pulls/123"]);
});

test("cached branches remain included when another branch hits the rate limit", async () => {
  const cache = createInclusionCache(cookieDocument());
  cache.add(123, "abcdef", "nixos-unstable");
  const client = fixture(mergedPR, [new GitHubError("Rate limit", 429)]);
  const result = await trackPR(123, { ...client, cache });
  assert.deepEqual(flattenTree(result.tree).map(node => node.state),
    ["accepted", "unknown", "unknown", "accepted"]);
  assert.equal(result.tree.children[1].children[0].cached, true);
  assert.equal(client.calls.length, 2);
});

test("malformed cookies are ignored and tracking can replace them", async () => {
  for (const value of ["%", "null", "{}", '{"mergeCommit":"abcdef","branches":[123]}']) {
    const document = cookieDocument();
    document.cookie = `nixpkgs-pr-included-v1-123=${encodeURIComponent(value)}`;
    const cache = createInclusionCache(document);
    const client = fixture();
    const result = await trackPR(123, { ...client, cache });
    assert.equal(client.calls.length, 4);
    assert.equal(result.tree.children[0].cached, false);
    assert.equal(cache.has(123, "abcdef", "nixpkgs-unstable"), true);
  }
});

test("missing, blocked, and silently rejected cookies do not interfere with tracking", async () => {
  for (const document of [
    undefined,
    { get cookie() { throw new Error("Blocked"); }, set cookie(_value) { throw new Error("Blocked"); } },
    { get cookie() { return ""; }, set cookie(_value) {} },
  ]) {
    const cache = createInclusionCache(document);
    for (let visit = 0; visit < 2; visit++) {
      const client = fixture(mergedPR, ["ahead", "ahead", "ahead"]);
      const result = await trackPR(123, { ...client, cache });
      assert.equal(client.calls.length, 4);
      assert.ok(flattenTree(result.tree).every(node => node.state === "accepted" && !node.cached));
    }
  }
});

test("saved tokens survive reloads and can be replaced or cleared without deleting branch cookies", () => {
  const document = cookieDocument();
  const cache = createInclusionCache(document);
  cache.add(123, "abcdef", "nixpkgs-unstable");
  const store = createTokenStore(document);
  assert.equal(store.load(), "");
  store.save(" example-token ");
  assert.equal(createTokenStore(document).load(), "example-token");
  assert.match(document.writes.at(-1), /; Path=\/; Max-Age=31536000; SameSite=Strict; Secure$/);
  assert.doesNotMatch(document.writes.at(-1), /; Domain=/i);
  store.save("replacement-token");
  assert.equal(createTokenStore(document).load(), "replacement-token");
  store.save(" ");
  assert.equal(createTokenStore(document).load(), "");
  assert.match(document.writes.at(-1), /; Max-Age=0;/);
  assert.equal(cache.has(123, "abcdef", "nixpkgs-unstable"), true);
});

test("token cookie values are encoded and always require secure transport", () => {
  const document = cookieDocument();
  document.location.protocol = "http:";
  const store = createTokenStore(document);
  store.save("example;token=with%separators");
  assert.equal(store.load(), "example;token=with%separators");
  assert.match(document.writes.at(-1), /^nixpkgs-pr-token-v1=example%3Btoken%3Dwith%25separators;/);
  assert.match(document.writes.at(-1), /; Secure$/);
});

test("malformed and unavailable token cookies do not break loading, saving, or clearing", () => {
  const malformed = cookieDocument();
  malformed.cookie = "nixpkgs-pr-token-v1=%broken";
  assert.equal(createTokenStore(malformed).load(), "");
  for (const document of [
    undefined,
    { get cookie() { throw new Error("Blocked"); }, set cookie(_value) { throw new Error("Blocked"); } },
    { get cookie() { return ""; }, set cookie(_value) {} },
  ]) {
    const store = createTokenStore(document);
    assert.equal(store.load(), "");
    store.save("example-token");
    assert.equal(store.load(), "");
    store.save("");
  }
});

test("the app restores tokens before automatic lookup, persists edits, and clears saved credentials", async () => {
  const document = cookieDocument();
  const store = createTokenStore(document);
  store.save("saved-token");
  const elements = new Map();
  document.getElementById = id => {
    if (!elements.has(id)) elements.set(id, {
      value: "", listeners: {},
      addEventListener(event, handler) { this.listeners[event] = handler; },
    });
    return elements.get(id);
  };
  let requestOptions;
  runInNewContext(readFileSync(require.resolve("../app.js"), "utf8"), {
    document, AbortController, URL, URLSearchParams,
    location: { search: "?pr=123" },
    window: { addEventListener() {} },
    PRTracker: {
      ...globalThis.PRTracker,
      createInclusionCache: () => createInclusionCache(document),
      createTokenStore: () => createTokenStore(document),
      createClient: options => createClient({
        ...options,
        fetchImpl: async (_url, init) => {
          requestOptions = init;
          return Response.json(mergedPR);
        },
      }),
    },
  });
  const token = elements.get("token");
  assert.equal(token.value, "saved-token");
  assert.equal(requestOptions.headers.Authorization, "Bearer saved-token");
  token.value = "edited-token";
  token.listeners.input();
  assert.equal(store.load(), "edited-token");
  elements.get("clear-token").listeners.click();
  assert.equal(token.value, "");
  assert.equal(createTokenStore(document).load(), "");
  assert.equal(requestOptions.signal.aborted, true);
  // Allow the cancelled request to settle; it must not restore the token or render results.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.load(), "");
  assert.equal(elements.get("result").hidden, true);
});

test("staging and release PRs follow their respective trees", async () => {
  for (const [base, branches] of [
    ["staging", ["staging", "staging-next", "master", "nixpkgs-unstable", "nixos-unstable-small", "nixos-unstable"]],
    ["staging-26.05", ["staging-26.05", "staging-next-26.05", "release-26.05", "nixpkgs-26.05-darwin", "nixos-26.05-small", "nixos-26.05"]],
  ]) {
    const client = fixture({ ...mergedPR, base: { ref: base } }, Array(5).fill("ahead"));
    const result = await trackPR(123, client);
    assert.deepEqual(flattenTree(result.tree).map(n => n.branch), branches);
    assert.ok(flattenTree(result.tree).every(n => n.state === "accepted"));
  }
});

test("open PRs ignore the synthetic merge SHA and show pending branches", async () => {
  const client = fixture({ ...mergedPR, state: "open", merged: false, merged_at: null });
  const result = await trackPR(123, client);
  assert.equal(result.state, "open");
  assert.ok(flattenTree(result.tree).every(n => n.state === "pending"));
  assert.equal(client.calls.length, 1);
});

test("closed unmerged PRs have no branch tree", async () => {
  const client = fixture({ ...mergedPR, merged: false, merged_at: null });
  const result = await trackPR(123, client);
  assert.equal(result.state, "closed");
  assert.equal(result.tree, null);
  assert.equal(client.calls.length, 1);
});

test("missing and historical synthetic merge SHAs leave downstream progress unknown", async () => {
  for (const pr of [
    { ...mergedPR, merge_commit_sha: null },
    { ...mergedPR, merged_at: "2013-10-06T14:05:21Z" },
  ]) {
    const client = fixture(pr);
    const result = await trackPR(123, client);
    assert.deepEqual(flattenTree(result.tree).map(n => n.state),
      ["accepted", "unknown", "unknown", "unknown"]);
    assert.match(result.warning, /reliable merge commit/);
    assert.equal(client.calls.length, 1);
  }
});

test("unknown base branch still records its merge without invented destinations", async () => {
  const client = fixture({ ...mergedPR, base: { ref: "custom/branch" } });
  const result = await trackPR(123, client);
  assert.equal(result.tree.state, "accepted");
  assert.deepEqual(result.tree.children, []);
  assert.equal(client.calls.length, 1);
});

test("a missing branch or server failure preserves the other branch results", async () => {
  for (const status of [404, 422, 500, 503]) {
    const client = fixture(mergedPR, [new GitHubError("Comparison unavailable", status), "ahead", "behind"]);
    const result = await trackPR(123, client);
    assert.deepEqual(flattenTree(result.tree).map(n => n.state),
      ["accepted", "unknown", "accepted", "pending"]);
    assert.equal(result.tree.children[0].detail, "Comparison unavailable");
    assert.equal(client.calls.length, 4);
  }
});

test("authentication and rate limit failures stop further requests", async () => {
  for (const status of [401, 403, 429]) {
    const client = fixture(mergedPR, ["ahead", new GitHubError("Quota or authentication failure", status)]);
    const result = await trackPR(123, client);
    assert.deepEqual(flattenTree(result.tree).map(n => n.state),
      ["accepted", "accepted", "unknown", "unknown"]);
    assert.equal(client.calls.length, 3);
  }
});

test("aborted lookups stop checking and publishing results", async () => {
  const controller = new AbortController();
  const client = fixture();
  let updates = 0;
  await assert.rejects(trackPR(123, {
    ...client, signal: controller.signal,
    onUpdate() { updates++; controller.abort(); },
  }), { name: "AbortError" });
  assert.equal(client.calls.length, 1);
  assert.equal(updates, 1);
});

test("the client uses only GitHub, omits cookies, and reports the returned quota", async () => {
  let quota;
  const request = createClient({
    token: " example-token ", onRateLimit: value => { quota = value; },
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.github.com/repos/NixOS/nixpkgs/pulls/123");
      assert.equal(options.headers.Authorization, "Bearer example-token");
      assert.equal(options.credentials, "omit");
      assert.equal(options.referrerPolicy, "no-referrer");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(mergedPR, { headers: {
        "x-ratelimit-remaining": "4999", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1800000000",
      } });
    },
  });
  assert.deepEqual(await request("/pulls/123"), mergedPR);
  assert.deepEqual(quota, { remaining: "4999", limit: "5000", reset: "1800000000" });
});

test("anonymous requests omit Authorization", async () => {
  const request = createClient({ fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return Response.json(mergedPR);
  } });
  await request("/pulls/123");
});

test("the client explains missing PRs, missing refs, invalid tokens, and rate limits", async () => {
  for (const [status, path, headers, message, expected] of [
    [404, "/pulls/123", {}, "Not Found", /No such.*pull request/],
    [404, "/compare/a...b", {}, "Not Found", /branch or commit may no longer exist/],
    [401, "/pulls/123", {}, "Bad credentials", /rejected the token/],
    [403, "/pulls/123", {}, "Forbidden", /denied this request/],
    [403, "/pulls/123", { "x-ratelimit-remaining": "0" }, "API rate limit exceeded", /rate limit was reached/],
    [403, "/pulls/123", { "x-ratelimit-remaining": "30" }, "secondary rate limit", /rate limit was reached/],
    [429, "/pulls/123", {}, "Too many requests", /rate limit was reached/],
    [503, "/pulls/123", {}, "Unavailable", /HTTP 503/],
  ]) {
    const request = createClient({
      fetchImpl: async () => Response.json({ message }, { status, headers }),
    });
    await assert.rejects(request(path), error => {
      assert.equal(error.status, status);
      assert.match(error.message, expected);
      return true;
    });
  }
});

test("non-JSON errors retain HTTP status so rate limit failures still stop tracking", async () => {
  const request = createClient({ fetchImpl: async () => new Response("Too many requests", { status: 429 }) });
  await assert.rejects(request("/pulls/123"), { status: 429 });
});

test("network, timeout, and malformed response errors are actionable", async () => {
  for (const [fetchImpl, expected] of [
    [async () => { throw new TypeError("Failed to fetch"); }, /Could not reach GitHub/],
    [async () => { throw new DOMException("Timed out", "TimeoutError"); }, /too long to respond/],
    [async () => new Response("<html>oops</html>"), /unreadable response/],
  ]) {
    await assert.rejects(createClient({ fetchImpl })("/pulls/123"), expected);
  }
});
