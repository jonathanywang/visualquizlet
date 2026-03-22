chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

let sidePanelPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    sidePanelPort = port;

    port.onDisconnect.addListener(() => {
      sidePanelPort = null;
    });

    // When the side panel connects, request current card from the active tab
    requestCurrentCard();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Forward messages from content script to side panel
  if (
    sender.tab &&
    (message.type === "CARD_CHANGED" || message.type === "SET_LOADED")
  ) {
    if (sidePanelPort) {
      sidePanelPort.postMessage(message);
    }
    return;
  }

  // Forward requests from side panel to content script
  if (message.type === "REQUEST_CURRENT_CARD" || message.type === "REQUEST_ALL_TERMS") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: "No Quizlet page found" });
          } else {
            sendResponse(response);
          }
        });
      } else {
        sendResponse({ error: "No active tab" });
      }
    });
    return true;
  }
});

// When the active tab changes or updates, re-request the current card
chrome.tabs.onActivated.addListener(() => {
  setTimeout(requestCurrentCard, 300);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") {
    setTimeout(requestCurrentCard, 500);
  }
});

function requestCurrentCard() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]?.id) return;
    const url = tabs[0].url || "";
    if (!url.includes("quizlet.com")) return;

    chrome.tabs.sendMessage(
      tabs[0].id,
      { type: "REQUEST_CURRENT_CARD" },
      () => {
        if (chrome.runtime.lastError) {
          // Content script not ready yet
        }
      }
    );
  });
}
