// SPDX-License-Identifier: AGPL-3.0-or-later WITH GPL-3.0-linking-exception
"use strict";

(() => {
  const {
    repository, parsePR, flattenTree, createInclusionCache, createTokenStore, createClient, trackPR,
  } = PRTracker;
  const cache = createInclusionCache();
  const tokenStore = createTokenStore();
  const $ = id => document.getElementById(id);
  const labels = {
    accepted: ["✓", "Included"],
    pending: ["○", "Pending"],
    checking: ["…", "Checking"],
    unknown: ["?", "Unknown"],
  };
  let activeRequest;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderNode(node, number) {
    const item = element("li", `branch ${node.state}`);
    const row = element("div", "branch-row");
    const [symbol, label] = labels[node.state];
    const icon = element("span", "state-icon", symbol);
    icon.setAttribute("aria-hidden", "true");
    const link = element("a", "branch-name", node.branch);
    link.href = `${repository}/tree/${encodeURIComponent(node.branch)}`;
    row.append(icon, link, element("span", "branch-state", node.cached ? "Included (cached)" : label));
    if (node.cached) {
      const refresh = element("button", "secondary branch-refresh", "Refresh");
      refresh.type = "button";
      refresh.setAttribute("aria-label", `Refresh inclusion in ${node.branch}`);
      refresh.addEventListener("click", () => track(String(number), false, node.branch));
      row.append(refresh);
    }
    if (node.hydra) {
      const hydra = element("a", "hydra", "Hydra ↗");
      hydra.href = node.hydra;
      hydra.setAttribute("aria-label", `Hydra builds for ${node.branch}`);
      row.append(hydra);
    }
    item.append(row);
    if (node.detail) item.append(element("p", "branch-detail", node.detail));
    if (node.children.length) {
      const children = document.createElement("ul");
      children.append(...node.children.map(child => renderNode(child, number)));
      item.append(children);
    }
    return item;
  }

  function render(result) {
    const { pr, state, tree, warning, complete } = result;
    $("result").hidden = false;
    $("pr-link").textContent = `#${pr.number}`;
    $("pr-link").href = `${repository}/pull/${pr.number}`;
    $("pr-title").textContent = pr.title;
    $("pr-state").textContent = state === "open" && pr.draft ? "Draft" : {
      merged: "Merged", closed: "Closed", open: "Open",
    }[state];
    $("pr-state").className = `badge ${state}`;
    $("pr-description").textContent = state === "closed"
      ? "This pull request was closed without merging."
      : state === "open"
        ? `Waiting to be merged into ${pr.base.ref}.`
        : `Merged into ${pr.base.ref}${pr.merged_at ? ` on ${new Date(pr.merged_at).toLocaleDateString()}` : ""}.`;
    $("warning").textContent = warning;
    $("warning").hidden = !warning;
    $("tree").replaceChildren(...(tree ? [renderNode(tree, pr.number)] : []));
    $("tree-help").hidden = !tree;
    document.title = `Nixpkgs PR #${pr.number}: ${pr.title}`;
    const nodes = tree ? flattenTree(tree) : [];
    const checking = nodes.filter(node => node.state === "checking").length;
    const unknown = nodes.filter(node => node.state === "unknown").length;
    $("status").textContent = !complete
      ? `Checking release branches… ${checking} remaining.`
      : unknown
        ? `Check complete. ${unknown} branch${unknown === 1 ? " has" : "es have"} unknown progress.`
        : `Loaded at ${new Date().toLocaleTimeString()}. Submit again to check uncached branches.`;
  }

  async function track(input, updateURL = true, forceBranch) {
    activeRequest?.abort();
    const controller = new AbortController();
    activeRequest = controller;
    $("error").hidden = true;
    $("result").hidden = true;
    $("status").textContent = "";
    $("rate-limit").textContent = "";
    document.title = "Nixpkgs Pull Request Tracker";
    try {
      const number = parsePR(input);
      $("pr").value = number;
      if (updateURL) {
        const url = new URL(location.href);
        url.searchParams.set("pr", number);
        // Some browsers restrict history changes on file:// pages.
        try { history.replaceState(null, "", url); } catch { /* Tracking still works. */ }
      }
      $("status").textContent = `Loading pull request #${number}…`;
      tokenStore.save($("token").value);
      const request = createClient({
        token: $("token").value,
        signal: controller.signal,
        onRateLimit({ remaining, limit, reset }) {
          if (controller.signal.aborted || remaining === null) return;
          $("rate-limit").textContent = `GitHub API: ${remaining}${limit ? ` / ${limit}` : ""} requests remaining` +
            (Number(reset) ? ` · resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}` : "");
        },
      });
      await trackPR(number, {
        request, signal: controller.signal, cache, forceBranch,
        onUpdate(result) { if (!controller.signal.aborted) render(result); },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      $("error").textContent = error.message;
      $("error").hidden = false;
      $("status").textContent = "";
    }
  }

  $("token").value = tokenStore.load();
  $("token").addEventListener("input", () => tokenStore.save($("token").value));
  $("track-form").addEventListener("submit", event => {
    event.preventDefault();
    track($("pr").value);
  });
  $("clear-token").addEventListener("click", () => {
    $("token").value = "";
    tokenStore.save("");
    // Stop requests still carrying the cleared token.
    activeRequest?.abort();
    $("result").hidden = true;
    $("error").hidden = true;
    $("rate-limit").textContent = "";
    $("status").textContent = "Token cleared. Submit a PR to continue without authentication.";
  });
  window.addEventListener("popstate", () => {
    const pr = new URLSearchParams(location.search).get("pr");
    if (pr) track(pr, false);
    else {
      activeRequest?.abort();
      $("result").hidden = true;
      $("error").hidden = true;
      $("status").textContent = "";
      $("pr").value = "";
      document.title = "Nixpkgs Pull Request Tracker";
    }
  });
  const initialPR = new URLSearchParams(location.search).get("pr");
  if (initialPR !== null) track(initialPR, false);
})();
