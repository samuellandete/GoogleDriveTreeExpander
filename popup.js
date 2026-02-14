const toggle = document.getElementById("toggle");
const statusText = document.getElementById("status-text");

// Load current state
chrome.storage.local.get("enabled", (result) => {
  const isEnabled = result.enabled !== false;
  toggle.checked = isEnabled;
  statusText.textContent = isEnabled ? "Enabled" : "Disabled";
});

// Handle toggle
toggle.addEventListener("change", () => {
  const isEnabled = toggle.checked;
  chrome.storage.local.set({ enabled: isEnabled });
  statusText.textContent = isEnabled ? "Enabled" : "Disabled";

  // Notify content script in active Drive tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.url?.includes("drive.google.com")) {
      chrome.tabs.sendMessage(tabs[0].id, { type: "toggle", enabled: isEnabled });
    }
  });
});
