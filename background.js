// Initialize default state on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: true });
  updateBadge(true);
});

// Update badge when storage changes
chrome.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    updateBadge(changes.enabled.newValue);
  }
});

function updateBadge(isEnabled) {
  chrome.action.setBadgeText({ text: isEnabled ? "" : "OFF" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
}

// On startup, restore badge state
chrome.storage.local.get("enabled", (result) => {
  updateBadge(result.enabled !== false);
});

// Listen for status updates from content script
let clearBadgeTimer = null;

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "status") {
    if (clearBadgeTimer) {
      clearTimeout(clearBadgeTimer);
      clearBadgeTimer = null;
    }

    const tabId = sender.tab?.id;
    const opts = tabId ? { tabId } : {};

    if (msg.status === "loading") {
      chrome.action.setBadgeText({ text: " ", ...opts });
      chrome.action.setBadgeBackgroundColor({ color: "#d93025", ...opts }); // red
    } else if (msg.status === "done") {
      chrome.action.setBadgeText({ text: " ", ...opts });
      chrome.action.setBadgeBackgroundColor({ color: "#0d904f", ...opts }); // green
      // Keep green for 4 seconds, then clear
      clearBadgeTimer = setTimeout(() => {
        chrome.action.setBadgeText({ text: "", ...opts });
      }, 4000);
    } else if (msg.status === "error") {
      chrome.action.setBadgeText({ text: "!", ...opts });
      chrome.action.setBadgeBackgroundColor({ color: "#e37400", ...opts }); // orange
      clearBadgeTimer = setTimeout(() => {
        chrome.action.setBadgeText({ text: "", ...opts });
      }, 5000);
    }
  }
});
