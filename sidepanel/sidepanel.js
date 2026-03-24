(function () {
  "use strict";

  // --- DOM refs ---
  const els = {
    connectionDot: document.getElementById("connection-dot"),
    connectionLabel: document.getElementById("connection-label"),
    stateWaiting: document.getElementById("state-waiting"),
    stateDrawing: document.getElementById("state-drawing"),
    stateComplete: document.getElementById("state-complete"),
    stateNoChinese: document.getElementById("state-no-chinese"),
    noChinText: document.getElementById("no-chinese-text"),
    progressBar: document.getElementById("progress-bar"),
    cardPosition: document.getElementById("card-position"),
    streakDisplay: document.getElementById("streak-display"),
    promptDefinition: document.getElementById("prompt-definition"),
    charSlots: document.getElementById("char-slots"),
    drawingTarget: document.getElementById("drawing-target"),
    strokeInfo: document.getElementById("stroke-info"),
    mistakeInfo: document.getElementById("mistake-info"),
    feedbackArea: document.getElementById("feedback-area"),
    btnHint: document.getElementById("btn-hint"),
    btnReset: document.getElementById("btn-reset"),
    btnSkip: document.getElementById("btn-skip"),
    btnRetry: document.getElementById("btn-retry"),
    toggleOutline: document.getElementById("toggle-outline"),
    completeChar: document.getElementById("complete-char"),
    completeMessage: document.getElementById("complete-message"),
    completeStats: document.getElementById("complete-stats"),
  };

  const CANVAS_SIZE = 280;
  const CANVAS_PADDING = 16;
  const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  // --- State ---
  let currentWriter = null;
  let currentCard = null;
  let characters = [];
  let charIndex = 0;
  let totalMistakes = 0;
  let cardMistakes = 0;
  let allTerms = [];
  let totalCards = 0;
  let cardsAttempted = new Set();
  let isConnected = false;

  // Session stats (persisted)
  let session = {
    cardsCompleted: 0,
    totalMistakes: 0,
    streak: 0,
    bestStreak: 0,
    startTime: Date.now(),
  };

  function dispatchRelayMessage(message) {
    if (!message || !message.type) return;
    if (message.type === "CARD_CHANGED") {
      handleCardChanged(message);
    } else if (message.type === "SET_LOADED") {
      if (message.allTerms) {
        allTerms = message.allTerms;
        totalCards = message.totalCards || allTerms.length;
      }
      setConnected(true);
    }
  }

  // Live updates from the service worker (survives MV3 worker restarts).
  chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
    dispatchRelayMessage(message);
    return false;
  });

  /** Instant UI when opening mid-session: last CARD_CHANGED / SET_LOADED was saved in session storage. */
  function hydrateFromCache() {
    try {
      if (!chrome.storage || !chrome.storage.session) return;
      chrome.storage.session.get(["vqLastRelay"], (data) => {
        if (data && data.vqLastRelay) {
          dispatchRelayMessage(data.vqLastRelay);
        }
      });
    } catch (e) {
      // storage.session unavailable
    }
  }

  hydrateFromCache();

  // Staggered REQUEST_CURRENT_CARD in the worker + resolve Quizlet tab even if focus is odd.
  chrome.runtime.sendMessage({ type: "PANEL_OPENED" }, () => {
    void chrome.runtime.lastError;
  });

  let visibilityResyncTimer = null;
  function scheduleVisibilityResync() {
    if (visibilityResyncTimer) clearTimeout(visibilityResyncTimer);
    visibilityResyncTimer = setTimeout(() => {
      visibilityResyncTimer = null;
      hydrateFromCache();
      chrome.runtime.sendMessage({ type: "PANEL_VISIBLE" }, () => {
        void chrome.runtime.lastError;
      });
    }, 100);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleVisibilityResync();
  });

  window.addEventListener("focus", scheduleVisibilityResync);

  // --- Load session from storage ---
  chrome.storage.local.get(["vqSession"], (data) => {
    if (data.vqSession) {
      const saved = data.vqSession;
      const hoursSince = (Date.now() - (saved.startTime || 0)) / 3600000;
      // Reset session if older than 4 hours
      if (hoursSince < 4) {
        session = { ...session, ...saved };
        updateStreakDisplay();
      }
    }
  });

  // --- State management ---

  function setState(stateName) {
    [els.stateWaiting, els.stateDrawing, els.stateComplete, els.stateNoChinese].forEach(
      (el) => el.classList.remove("active")
    );
    const target = {
      waiting: els.stateWaiting,
      drawing: els.stateDrawing,
      complete: els.stateComplete,
      noChinese: els.stateNoChinese,
    }[stateName];
    if (target) target.classList.add("active");
  }

  function setConnected(connected) {
    isConnected = connected;
    els.connectionDot.className = "dot " + (connected ? "connected" : "disconnected");
    els.connectionLabel.textContent = connected ? "Synced" : "Not connected";
  }

  // --- Handle card changes from content script ---

  function handleCardChanged(data) {
    setConnected(true);

    if (data.allTerms && data.allTerms.length > 0) {
      allTerms = data.allTerms;
      totalCards = data.totalCards || allTerms.length;
    }
    if (data.totalCards) {
      totalCards = data.totalCards;
    }

    const chinese = data.chinese;
    const definition = data.definition || "";
    const visibleSide = data.visibleSide;

    // If the definition side is showing, prompt user to draw the chinese
    if (visibleSide === "definition" && chinese) {
      startDrawing(chinese, definition);
      return;
    }

    // If the chinese side is showing (user hasn't flipped yet), we can't quiz
    // Show a message or try to find the matching definition
    if (visibleSide === "chinese" && chinese) {
      const match = allTerms.find((t) => t.chinese === chinese);
      if (match) {
        startDrawing(match.chinese, match.definition);
      } else {
        // Show the chinese side -- user might want to study it first
        startDrawing(chinese, definition || "Flip the card to see the definition");
      }
      return;
    }

    // No Chinese character detected
    if (!chinese && data.visibleText) {
      const match = allTerms.find(
        (t) => t.definition === data.visibleText.trim()
      );
      if (match) {
        startDrawing(match.chinese, match.definition);
        return;
      }
    }

    // Nothing useful
    if (!chinese) {
      els.noChinText.textContent =
        "This card doesn't have a Chinese character to practice.";
      setState("noChinese");
      return;
    }

    startDrawing(chinese, definition);
  }

  // --- Drawing logic ---

  function startDrawing(chinese, definition) {
    if (
      currentCard &&
      currentCard.chinese === chinese &&
      currentCard.definition === definition
    ) {
      return; // Same card, don't reset
    }

    cleanupWriter();

    currentCard = { chinese, definition };
    characters = extractChineseChars(chinese);
    charIndex = 0;
    cardMistakes = 0;
    totalMistakes = 0;

    if (characters.length === 0) {
      els.noChinText.textContent =
        "Could not find a valid Chinese character in: " + chinese;
      setState("noChinese");
      return;
    }

    cardsAttempted.add(chinese);
    updateProgressBar();
    updateCardPosition();
    updatePrompt(definition);
    renderCharSlots();
    setState("drawing");
    quizNextChar();
  }

  function extractChineseChars(text) {
    const chars = [];
    for (const ch of text) {
      if (CJK_REGEX.test(ch)) chars.push(ch);
    }
    return chars;
  }

  function quizNextChar() {
    if (charIndex >= characters.length) {
      onCardComplete();
      return;
    }

    cleanupWriter();
    updateCharSlots();
    updateFeedback(0, 0, characters.length - charIndex);

    const char = characters[charIndex];
    const showOutline = els.toggleOutline.checked;

    try {
      currentWriter = HanziWriter.create("drawing-target", char, {
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        padding: CANVAS_PADDING,
        showCharacter: false,
        showOutline: showOutline,
        strokeColor: "#1f2937",
        outlineColor: "#e5e7eb",
        highlightColor: "#22c55e",
        drawingColor: "#1f2937",
        drawingWidth: 6,
        showHintAfterMisses: 3,
        highlightOnComplete: true,
        charDataLoader: function (char, onComplete) {
          const url =
            "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/" +
            char +
            ".json";
          fetch(url)
            .then((r) => {
              if (!r.ok) throw new Error("not found");
              return r.json();
            })
            .then(onComplete)
            .catch(() => {
              onCharNotFound(char);
            });
        },
      });

      currentWriter.quiz({
        onCorrectStroke: function (strokeData) {
          updateFeedback(
            strokeData.strokeNum + 1,
            strokeData.totalMistakes,
            strokeData.strokesRemaining
          );
        },
        onMistake: function (strokeData) {
          cardMistakes++;
          totalMistakes++;
          els.drawingTarget.classList.add("mistake");
          setTimeout(
            () => els.drawingTarget.classList.remove("mistake"),
            350
          );
          updateFeedback(
            strokeData.strokeNum,
            strokeData.totalMistakes,
            strokeData.strokesRemaining + 1
          );
        },
        onComplete: function (summaryData) {
          els.drawingTarget.classList.add("success");
          setTimeout(() => {
            els.drawingTarget.classList.remove("success");
            charIndex++;
            updateCharSlots();
            setTimeout(quizNextChar, 300);
          }, 600);
        },
      });
    } catch (e) {
      onCharNotFound(char);
    }
  }

  function onCharNotFound(char) {
    charIndex++;
    if (charIndex < characters.length) {
      setTimeout(quizNextChar, 100);
    } else {
      onCardComplete();
    }
  }

  function onCardComplete() {
    session.cardsCompleted++;
    session.totalMistakes += cardMistakes;

    if (cardMistakes === 0) {
      session.streak++;
      session.bestStreak = Math.max(session.bestStreak, session.streak);
    } else {
      session.streak = 0;
    }

    saveSession();
    updateStreakDisplay();

    els.completeChar.textContent = currentCard.chinese;
    els.completeMessage.textContent =
      cardMistakes === 0
        ? "Perfect! Flip the card to confirm."
        : "Done! You made " + cardMistakes + " mistake" + (cardMistakes === 1 ? "" : "s") + ". Flip the card to confirm.";
    els.completeStats.textContent =
      "Session: " +
      session.cardsCompleted +
      " cards completed, streak: " +
      session.streak;

    setState("complete");
  }

  function cleanupWriter() {
    if (currentWriter) {
      try {
        currentWriter.cancelQuiz();
      } catch (e) {}
      currentWriter = null;
    }
    // Clear the SVG from drawing target, but keep the rice grid
    const svgs = els.drawingTarget.querySelectorAll("svg");
    svgs.forEach((svg) => svg.remove());
    els.drawingTarget.classList.remove("success", "mistake");
  }

  // --- UI update helpers ---

  function updatePrompt(definition) {
    els.promptDefinition.textContent = definition || "";
  }

  function renderCharSlots() {
    els.charSlots.innerHTML = "";
    if (characters.length <= 1) return;
    characters.forEach((ch, i) => {
      const slot = document.createElement("div");
      slot.className = "char-slot";
      slot.textContent = i + 1;
      slot.dataset.index = i;
      els.charSlots.appendChild(slot);
    });
  }

  function updateCharSlots() {
    const slots = els.charSlots.querySelectorAll(".char-slot");
    slots.forEach((slot, i) => {
      slot.classList.remove("active", "done");
      if (i < charIndex) {
        slot.classList.add("done");
        slot.textContent = characters[i];
      } else if (i === charIndex) {
        slot.classList.add("active");
        slot.textContent = i + 1;
      } else {
        slot.textContent = i + 1;
      }
    });
  }

  function updateFeedback(strokesDone, mistakes, remaining) {
    els.strokeInfo.textContent =
      "Strokes: " + strokesDone + (remaining > 0 ? " / " + (strokesDone + remaining) : "");
    els.mistakeInfo.textContent =
      mistakes > 0 ? "Mistakes: " + mistakes : "";
  }

  function updateProgressBar() {
    if (totalCards > 0 && cardsAttempted.size > 0) {
      const pct = Math.round((cardsAttempted.size / totalCards) * 100);
      els.progressBar.style.width = pct + "%";
    } else {
      els.progressBar.style.width = "0%";
    }
  }

  function updateCardPosition() {
    if (totalCards > 0) {
      els.cardPosition.textContent =
        cardsAttempted.size + " / " + totalCards + " cards";
    } else {
      els.cardPosition.textContent = "";
    }
  }

  function updateStreakDisplay() {
    els.streakDisplay.textContent = "Streak: " + session.streak;
  }

  // --- Session persistence ---

  function saveSession() {
    chrome.storage.local.set({ vqSession: session });
  }

  // --- Control buttons ---

  els.btnHint.addEventListener("click", () => {
    if (characters.length === 0 || charIndex >= characters.length) return;
    cleanupWriter();

    const char = characters[charIndex];
    const showOutline = els.toggleOutline.checked;

    const hintWriter = HanziWriter.create("drawing-target", char, {
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      padding: CANVAS_PADDING,
      showCharacter: false,
      showOutline: showOutline,
      strokeAnimationSpeed: 1.5,
      delayBetweenStrokes: 80,
      strokeColor: "#22c55e",
      outlineColor: "#e5e7eb",
      charDataLoader: function (char, onComplete) {
        const url =
          "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/" +
          char +
          ".json";
        fetch(url)
          .then((r) => r.json())
          .then(onComplete)
          .catch(() => {});
      },
    });

    hintWriter.animateCharacter({
      onComplete: function () {
        setTimeout(() => {
          cleanupWriter();
          quizNextChar();
        }, 800);
      },
    });

    currentWriter = hintWriter;
  });

  els.btnReset.addEventListener("click", () => {
    if (characters.length === 0 || charIndex >= characters.length) return;
    cleanupWriter();
    quizNextChar();
  });

  els.btnSkip.addEventListener("click", () => {
    session.streak = 0;
    updateStreakDisplay();
    cleanupWriter();

    if (currentCard) {
      els.completeChar.textContent = currentCard.chinese;
      els.completeMessage.textContent = "Skipped. Advance to the next card on Quizlet.";
      els.completeStats.textContent = "";
      setState("complete");
    } else {
      setState("waiting");
    }
  });

  els.btnRetry.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "REQUEST_CURRENT_CARD" });
  });

  els.toggleOutline.addEventListener("change", () => {
    if (characters.length === 0 || charIndex >= characters.length) return;
    // Restart the current character quiz with new outline setting
    cleanupWriter();
    quizNextChar();
  });

})();
