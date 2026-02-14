(async function () {
  "use strict";

  const POLL_INTERVAL_MS = 800;
  const DEBOUNCE_MS = 600;
  const WAIT_TIMEOUT_MS = 10000;
  const WAIT_POLL_MS = 250;
  const LOG_PREFIX = "[DriveTreeExpander]";

  let lastUrl = "";
  let debounceTimer = null;
  let enabled = true;
  let expanding = false;

  // --- State management ---

  async function loadEnabled() {
    try {
      const result = await chrome.storage.local.get("enabled");
      enabled = result.enabled !== false;
    } catch {
      enabled = true;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "toggle") {
      enabled = msg.enabled;
      log("Toggled:", enabled ? "ON" : "OFF");
      if (enabled) onNavigate();
    }
  });

  // --- Logging ---

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  function sendStatus(status) {
    try { chrome.runtime.sendMessage({ type: "status", status }); } catch {}
  }

  // --- DOM helpers ---

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function simulateClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function waitForCondition(predicate, timeout = WAIT_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (predicate()) { resolve(true); return; }
      const interval = setInterval(() => {
        if (predicate()) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(true);
        }
      }, WAIT_POLL_MS);
      const timer = setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, timeout);
    });
  }

  // --- Breadcrumb extraction ---

  async function getFullBreadcrumbPath() {
    const nav = document.querySelector('nav[guidedhelpid="folder_path"]');
    if (!nav) {
      log("Breadcrumb nav not found.");
      return [];
    }

    let collapsedSegments = [];

    const collapseBtn = nav.querySelector('[data-target="collapsedFolderButton"]');
    if (collapseBtn && collapseBtn.getAttribute("aria-expanded") === "false") {
      collapsedSegments = await getCollapsedSegments(collapseBtn);
    }

    const visibleSegments = [];
    const list = nav.querySelector('[role="list"]');
    if (list) {
      const items = list.querySelectorAll('[role="listitem"]');
      for (const item of items) {
        if (item.querySelector('[data-target="collapsedFolderButton"]')) continue;
        const inner = item.querySelector('[role="link"], [role="button"], [aria-label]');
        const label = inner ? inner.getAttribute("aria-label") : null;
        if (label) {
          visibleSegments.push(label);
          continue;
        }
        const clone = item.cloneNode(true);
        clone.querySelectorAll("svg, img, [aria-hidden='true']").forEach((c) => c.remove());
        const text = clone.textContent.trim();
        if (text) visibleSegments.push(text);
      }
    }

    const segments = [...collapsedSegments, ...visibleSegments];
    log("Breadcrumb segments (before root detection):", segments);
    return segments;
  }

  async function getCollapsedSegments(collapseBtn) {
    log("Opening collapsed breadcrumb popup...");
    simulateClick(collapseBtn);
    await sleep(700);

    const dropdown = document.querySelector('[data-target="collapsedFolderDropdown"]');
    const segments = [];

    if (dropdown) {
      log("Found collapsedFolderDropdown, reading items...");
      let items = dropdown.querySelectorAll('[role="menuitem"]');
      if (items.length === 0) items = dropdown.querySelectorAll(".h-v, .a-w-V");
      if (items.length === 0) items = findLeafTextElements(dropdown);

      for (const item of items) {
        const label = item.getAttribute("aria-label");
        if (label) { segments.push(label); continue; }
        const clone = item.cloneNode(true);
        clone.querySelectorAll("svg, img, [aria-hidden='true']").forEach((c) => c.remove());
        const text = clone.textContent.trim();
        if (text && text !== "..." && text !== "Show Path") segments.push(text);
      }
      log("Collapsed segments:", segments);
    } else {
      warn("collapsedFolderDropdown not found after clicking.");
      const menus = document.querySelectorAll('[role="menu"]');
      for (const menu of menus) {
        if (menu.offsetParent !== null) {
          const items = menu.querySelectorAll('[role="menuitem"]');
          for (const item of items) {
            const clone = item.cloneNode(true);
            clone.querySelectorAll("svg, img").forEach((c) => c.remove());
            const text = clone.textContent.trim();
            if (text) segments.push(text);
          }
          if (segments.length > 0) break;
        }
      }
    }

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true })
    );
    await sleep(300);
    if (collapseBtn.getAttribute("aria-expanded") === "true") {
      simulateClick(collapseBtn);
      await sleep(200);
    }
    return segments;
  }

  function findLeafTextElements(root) {
    const results = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.children.length === 0 || !Array.from(node.children).some(c => c.textContent.trim())) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text && text.length < 200) results.push(node);
    }
    return results;
  }

  // --- Sidebar tree interaction ---

  function getTree() {
    return document.querySelector('nav[data-target="navTree"] [role="tree"]');
  }

  function getRawTreeItemLabel(treeitem) {
    const labelledBy = treeitem.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelId = labelledBy.split(" ")[0];
      const labelEl = document.getElementById(labelId);
      if (labelEl) {
        const clone = labelEl.cloneNode(true);
        clone.querySelectorAll("svg, img").forEach((c) => c.remove());
        return clone.textContent.trim();
      }
    }
    const labelEl = treeitem.querySelector(".a-U-J-x");
    if (labelEl) {
      const clone = labelEl.cloneNode(true);
      clone.querySelectorAll("svg, img").forEach((c) => c.remove());
      return clone.textContent.trim();
    }
    return "";
  }

  function stripDriveSuffix(rawLabel) {
    const suffixes = [
      "Shared Google Drive Folder",
      "Google Drive Folder Shortcut",
      "Google Drive Folder",
    ];
    for (const suffix of suffixes) {
      const idx = rawLabel.lastIndexOf(suffix);
      if (idx > 0) return rawLabel.substring(0, idx).trim();
    }
    return rawLabel.trim();
  }

  function getTreeItemLabel(treeitem) {
    return stripDriveSuffix(getRawTreeItemLabel(treeitem));
  }

  function findTreeItemByLabel(text, parent) {
    const items = parent.querySelectorAll(":scope > [role='treeitem']");
    const target = text.toLowerCase().trim();

    // Exact match on cleaned label
    for (const item of items) {
      if (getTreeItemLabel(item).toLowerCase().trim() === target) return item;
    }

    // Raw label starts with target (handles suffix not being stripped)
    for (const item of items) {
      const raw = getRawTreeItemLabel(item).toLowerCase().trim();
      if (raw.startsWith(target + "google") || raw.startsWith(target + "shared")) return item;
    }

    // Starts-with match on cleaned labels
    for (const item of items) {
      const label = getTreeItemLabel(item).toLowerCase().trim();
      if (label.startsWith(target) || target.startsWith(label)) return item;
    }

    return null;
  }

  // --- Scrolling within tree groups to load lazy/virtualized items ---

  async function findItemByScrolling(text, groupEl) {
    // Google Drive may virtualize tree children — only items in view are in the DOM.
    // Scroll the sidebar's scroll container to trigger rendering of off-screen items.

    // Find a valid scrollable ancestor (must have clientHeight > 0)
    const sidebarNav = document.querySelector('nav[data-target="navTree"]');
    let scrollContainer = null;

    // Walk up from the sidebar nav to find the real scroll container
    let candidate = sidebarNav || groupEl;
    while (candidate && candidate !== document.documentElement) {
      if (candidate.clientHeight > 50 && candidate.scrollHeight > candidate.clientHeight + 20) {
        scrollContainer = candidate;
        break;
      }
      candidate = candidate.parentElement;
    }

    if (!scrollContainer) {
      log("No valid scrollable container found for tree, skipping scroll search.");
      return null;
    }

    log("Scrolling tree to find:", text,
      "container:", scrollContainer.tagName + "." + (scrollContainer.className || "").toString().substring(0, 30),
      "scrollH:", scrollContainer.scrollHeight, "clientH:", scrollContainer.clientHeight);

    const scrollStep = Math.max(scrollContainer.clientHeight * 0.7, 100);
    const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    let currentScroll = 0;
    const MAX_ITERATIONS = 50; // Safety limit

    // Scroll to top first
    scrollContainer.scrollTop = 0;
    await sleep(300);

    let found = findTreeItemByLabel(text, groupEl);
    if (found) return found;

    // Scroll down in steps, checking after each
    let iterations = 0;
    while (currentScroll < maxScroll && iterations < MAX_ITERATIONS) {
      iterations++;
      currentScroll = Math.min(currentScroll + scrollStep, maxScroll);
      scrollContainer.scrollTop = currentScroll;
      await sleep(400);

      found = findTreeItemByLabel(text, groupEl);
      if (found) {
        log("Found item after scrolling to:", currentScroll);
        return found;
      }
    }

    log("Item not found after scrolling through entire tree.");
    return null;
  }

  async function expandTreeItem(treeitem) {
    const label = getTreeItemLabel(treeitem);

    if (treeitem.getAttribute("aria-expanded") === "true") {
      log("Already expanded:", label);
      const group = treeitem.querySelector('[role="group"]');
      if (group && group.querySelectorAll(':scope > [role="treeitem"]').length === 0) {
        log("Waiting for children to load...");
        await waitForCondition(
          () => group.querySelectorAll(':scope > [role="treeitem"]').length > 0,
          WAIT_TIMEOUT_MS
        );
      }
      return true;
    }

    if (treeitem.getAttribute("aria-expanded") !== "false") {
      log("Not expandable (leaf):", label);
      return true;
    }

    log("Expanding:", label);

    const expander = treeitem.querySelector('[data-target="expander"]');
    if (expander) {
      simulateClick(expander);
    } else {
      simulateClick(treeitem);
    }

    let success = await waitForCondition(
      () => treeitem.getAttribute("aria-expanded") === "true",
      WAIT_TIMEOUT_MS
    );

    if (!success) {
      log("First click didn't expand. Retrying...");
      const innerArrow = treeitem.querySelector(".a-U-Ze") || treeitem.querySelector('[data-target="node"]');
      if (innerArrow) {
        simulateClick(innerArrow);
        success = await waitForCondition(
          () => treeitem.getAttribute("aria-expanded") === "true",
          WAIT_TIMEOUT_MS / 2
        );
      }
    }

    if (!success) {
      (expander || treeitem).click();
      success = await waitForCondition(
        () => treeitem.getAttribute("aria-expanded") === "true",
        WAIT_TIMEOUT_MS / 2
      );
    }

    if (!success) {
      warn("Failed to expand:", label);
      return false;
    }

    log("Expanded:", label, "- waiting for children...");

    const group = treeitem.querySelector('[role="group"]');
    if (group) {
      await waitForCondition(
        () => group.querySelectorAll(':scope > [role="treeitem"]').length > 0,
        WAIT_TIMEOUT_MS
      );
      const childCount = group.querySelectorAll(':scope > [role="treeitem"]').length;
      log(`Children loaded: ${childCount} items`);
    }

    return true;
  }

  // --- Root detection ---

  async function detectAndPrependRoot(pathSegments, tree) {
    if (pathSegments.length === 0) return pathSegments;

    // If the first segment already matches a top-level tree item
    if (findTreeItemByLabel(pathSegments[0], tree)) {
      log("First segment matches a top-level tree item.");
      return pathSegments;
    }

    const candidateRoots = ["My Drive", "Shared drives", "Computers"];

    for (const rootName of candidateRoots) {
      const rootItem = findTreeItemByLabel(rootName, tree);
      if (!rootItem) continue;
      if (rootItem.getAttribute("aria-expanded") === null) continue;

      log(`Checking if "${pathSegments[0]}" is under "${rootName}"...`);

      const ok = await expandTreeItem(rootItem);
      if (!ok) continue;

      const group = rootItem.querySelector('[role="group"]');
      if (!group) continue;

      // First try direct match among loaded items
      let match = findTreeItemByLabel(pathSegments[0], group);

      // If not found, try scrolling to load virtualized items
      if (!match) {
        match = await findItemByScrolling(pathSegments[0], group);
      }

      if (match) {
        log(`Found! "${pathSegments[0]}" is a child of "${rootName}".`);
        return [rootName, ...pathSegments];
      }
    }

    log("Could not detect root. Defaulting to My Drive.");
    return ["My Drive", ...pathSegments];
  }

  // --- Main expansion logic ---

  async function expandTreeToPath(pathSegments) {
    if (expanding) {
      log("Already expanding, skipping.");
      return;
    }
    expanding = true;
    sendStatus("loading");

    try {
      let tree = getTree();
      if (!tree) {
        log("Tree not found, waiting...");
        await waitForCondition(() => getTree(), WAIT_TIMEOUT_MS);
        tree = getTree();
      }
      if (!tree) {
        warn("Sidebar tree not found.");
        sendStatus("error");
        return;
      }

      pathSegments = await detectAndPrependRoot(pathSegments, tree);
      log("Expanding tree for path:", pathSegments.join(" > "));

      let currentParent = tree;
      let lastMatchedItem = null;

      for (let i = 0; i < pathSegments.length; i++) {
        const segment = pathSegments[i];
        log(`[${i}/${pathSegments.length - 1}] Looking for: "${segment}"`);

        // First, try direct match (item already in DOM)
        let item = null;
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (!item && Date.now() < deadline) {
          item = findTreeItemByLabel(segment, currentParent);
          if (!item) await sleep(WAIT_POLL_MS);
        }

        // If not found, try scrolling to trigger lazy loading
        if (!item) {
          log(`"${segment}" not in DOM. Trying to scroll to load more items...`);
          item = await findItemByScrolling(segment, currentParent);
        }

        if (!item) {
          const available = currentParent.querySelectorAll(':scope > [role="treeitem"]');
          const names = Array.from(available).slice(0, 10).map((el) => getTreeItemLabel(el));
          warn(`Could not find "${segment}". First ${names.length} available:`, names);
          break;
        }

        log(`Found: "${getTreeItemLabel(item)}"`);
        lastMatchedItem = item;

        if (i < pathSegments.length - 1) {
          const ok = await expandTreeItem(item);
          if (!ok) break;

          const group = item.querySelector('[role="group"]');
          if (group) {
            currentParent = group;
          } else {
            warn(`No child group found for: "${segment}"`);
            break;
          }
        }
      }

      if (lastMatchedItem) {
        const nodeRow = lastMatchedItem.querySelector('[data-target="node"]') || lastMatchedItem;
        await sleep(300);
        scrollSidebarTo(nodeRow);
        log("Done. Scrolled to:", getTreeItemLabel(lastMatchedItem));
        highlightItem(lastMatchedItem);
        sendStatus("done");
      } else {
        sendStatus("error");
      }
    } finally {
      expanding = false;
    }
  }

  function scrollSidebarTo(el) {
    // Find the sidebar's scrollable container
    const sidebarNav = document.querySelector('nav[data-target="navTree"]');
    let scrollContainer = null;

    // Walk up from the nav tree
    let candidate = sidebarNav || el;
    while (candidate && candidate !== document.documentElement) {
      if (candidate.scrollHeight > candidate.clientHeight + 5) {
        scrollContainer = candidate;
        break;
      }
      candidate = candidate.parentElement;
    }

    // Also check the nav element itself
    if (!scrollContainer && sidebarNav && sidebarNav.scrollHeight > sidebarNav.clientHeight + 5) {
      scrollContainer = sidebarNav;
    }

    // Walk up from the element itself as fallback
    if (!scrollContainer) {
      candidate = el.parentElement;
      while (candidate && candidate !== document.documentElement) {
        if (candidate.scrollHeight > candidate.clientHeight + 5) {
          scrollContainer = candidate;
          break;
        }
        candidate = candidate.parentElement;
      }
    }

    if (scrollContainer) {
      const elRect = el.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const relativeTop = elRect.top - containerRect.top;
      const desiredScroll =
        scrollContainer.scrollTop + relativeTop - containerRect.height / 2 + elRect.height / 2;

      log("Scrolling sidebar:", {
        container: scrollContainer.tagName + "." + (scrollContainer.className || "").toString().substring(0, 40),
        scrollH: scrollContainer.scrollHeight,
        clientH: scrollContainer.clientHeight,
        from: Math.round(scrollContainer.scrollTop),
        to: Math.round(Math.max(0, desiredScroll)),
      });

      scrollContainer.scrollTo({ top: Math.max(0, desiredScroll), behavior: "smooth" });
    } else {
      // Last resort: scrollIntoView on the element
      log("No scroll container found. Using scrollIntoView.");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // --- Persistent highlight via injected <style> ---
  // Uses a CSS rule targeting [data-tree-id] so it survives Drive's re-renders.

  let highlightStyleEl = null;

  function highlightItem(item) {
    // Remove previous highlight
    clearHighlight();

    const treeId = item.getAttribute("data-tree-id");
    if (!treeId) {
      // Fallback for items without data-tree-id: use inline style
      const nodeEl = item.querySelector('[data-target="node"]') || item;
      nodeEl.style.outline = "2px solid #1a73e8";
      nodeEl.style.outlineOffset = "-2px";
      nodeEl.style.borderRadius = "4px";
      return;
    }

    // Inject a <style> rule — persists through Drive's DOM re-renders
    highlightStyleEl = document.createElement("style");
    highlightStyleEl.id = "drive-tree-expander-highlight";
    highlightStyleEl.textContent = `
      [data-tree-id="${CSS.escape(treeId)}"] > [data-target="node"] {
        outline: 2px solid #1a73e8 !important;
        outline-offset: -2px !important;
        border-radius: 4px !important;
        background-color: rgba(26, 115, 232, 0.08) !important;
      }
    `;
    document.head.appendChild(highlightStyleEl);
  }

  function clearHighlight() {
    if (highlightStyleEl) {
      highlightStyleEl.remove();
      highlightStyleEl = null;
    }
    // Also remove the old injected style if it exists from a previous version
    const old = document.getElementById("drive-tree-expander-highlight");
    if (old) old.remove();
  }

  // --- Navigation monitoring ---

  async function onNavigate() {
    if (!enabled || expanding) return;
    const url = window.location.href;
    if (!url.includes("/drive/")) return;

    log("Navigation detected:", url);
    clearHighlight();
    await sleep(1000);

    const pathSegments = await getFullBreadcrumbPath();
    if (pathSegments.length === 0) {
      log("No breadcrumb path found.");
      return;
    }
    await expandTreeToPath(pathSegments);
  }

  function startUrlMonitor() {
    lastUrl = window.location.href;
    setInterval(() => {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => onNavigate(), DEBOUNCE_MS);
      }
    }, POLL_INTERVAL_MS);
  }

  // --- Initialization ---

  async function init() {
    await loadEnabled();
    log("Initialized. Enabled:", enabled);
    startUrlMonitor();
    if (enabled) {
      await sleep(2500);
      await onNavigate();
    }
  }

  init();
})();
