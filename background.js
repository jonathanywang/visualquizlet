chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

const RESYNC_DELAYS_MS = [0, 400, 1200];

/**
 * Relay card updates to the side panel via runtime.sendMessage.
 * Unlike a long-lived Port, this survives Manifest V3 service worker
 * restarts (the worker often goes idle and drops Port references).
 */
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message, () => {
    void chrome.runtime.lastError;
  });
}

/** Keep last payload so a newly opened side panel can hydrate before the next DOM tick. */
function persistRelay(message) {
  try {
    if (chrome.storage && chrome.storage.session) {
      chrome.storage.session.set({ vqLastRelay: message });
    }
  } catch (e) {
    // Older Chrome without storage.session
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // From Quizlet content script → extension UI (side panel)
  if (
    sender.tab &&
    (message.type === "CARD_CHANGED" || message.type === "SET_LOADED")
  ) {
    persistRelay(message);
    broadcastToSidePanel(message);
    return;
  }

  // Side panel opened or became visible — pull current card from Quizlet (with retries)
  if (message.type === "PANEL_OPENED" || message.type === "PANEL_VISIBLE") {
    scheduleResyncToQuizlet();
    sendResponse({ ok: true });
    return false;
  }

  // Forward requests from side panel to content script
  if (message.type === "REQUEST_CURRENT_CARD" || message.type === "REQUEST_ALL_TERMS") {
    resolveQuizletTabId((tabId) => {
      if (tabId == null) {
        sendResponse({ error: "No Quizlet page found" });
        return;
      }
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: "No Quizlet page found" });
        } else {
          sendResponse(response);
        }
      });
    });
    return true;
  }
});

/**
 * Prefer active tab in last-focused window; if it's not Quizlet, use any Quizlet tab in that window.
 */
function resolveQuizletTabId(callback) {
  chrome.tabs.query({ lastFocusedWindow: true, active: true }, (tabs) => {
    const direct = pickQuizletTabId(tabs);
    if (direct != null) {
      callback(direct);
      return;
    }
    chrome.tabs.query({ lastFocusedWindow: true, url: "*://*.quizlet.com/*" }, (quizletTabs) => {
      callback(quizletTabs[0]?.id ?? null);
    });
  });
}

function pickQuizletTabId(tabs) {
  const t = tabs && tabs[0];
  if (t?.id && t.url && t.url.includes("quizlet.com")) return t.id;
  return null;
}

// When the active tab changes or finishes loading, ask content script to re-emit state
chrome.tabs.onActivated.addListener(() => {
  setTimeout(requestCurrentCard, 300);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    setTimeout(requestCurrentCard, 500);
  }
});

function scheduleResyncToQuizlet() {
  RESYNC_DELAYS_MS.forEach((ms) => {
    setTimeout(requestCurrentCard, ms);
  });
}

function requestCurrentCard() {
  chrome.tabs.query({ lastFocusedWindow: true, active: true }, (tabs) => {
    const direct = pickQuizletTabId(tabs);
    if (direct != null) {
      sendRequestToTab(direct);
      return;
    }
    chrome.tabs.query({ lastFocusedWindow: true, url: "*://*.quizlet.com/*" }, (quizletTabs) => {
      if (quizletTabs[0]?.id) {
        sendRequestToTab(quizletTabs[0].id);
      }
    });
  });
}

function sendRequestToTab(tabId) {
  chrome.tabs.sendMessage(
    tabId,
    { type: "REQUEST_CURRENT_CARD" },
    () => {
      void chrome.runtime.lastError;
    }
  );
}
