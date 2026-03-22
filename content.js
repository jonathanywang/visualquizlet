(function () {
  "use strict";

  const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  const DEBOUNCE_MS = 150;

  let lastSentText = "";
  let debounceTimer = null;
  let totalCards = 0;
  let observer = null;

  function isChinese(text) {
    return CJK_REGEX.test(text);
  }

  function classifyCard(textA, textB) {
    const aIsChinese = isChinese(textA);
    const bIsChinese = isChinese(textB);

    if (aIsChinese && !bIsChinese) {
      return { chinese: textA.trim(), definition: textB.trim() };
    }
    if (bIsChinese && !aIsChinese) {
      return { chinese: textB.trim(), definition: textA.trim() };
    }
    if (aIsChinese && bIsChinese) {
      return { chinese: textA.trim(), definition: textB.trim() };
    }
    return null;
  }

  // --- Selector strategies for extracting all term pairs from a set page ---

  function scrapeAllTerms() {
    const strategies = [
      scrapeByTermText,
      scrapeBySetPageTerm,
      scrapeByAriaAndRole,
      scrapeByGenericPairs,
    ];

    for (const strategy of strategies) {
      const results = strategy();
      if (results && results.length > 0) return results;
    }
    return [];
  }

  function scrapeByTermText() {
    const nodes = document.querySelectorAll(".TermText");
    if (nodes.length < 2) return null;
    const cards = [];
    for (let i = 0; i < nodes.length - 1; i += 2) {
      const a = nodes[i].textContent || "";
      const b = nodes[i + 1].textContent || "";
      const classified = classifyCard(a, b);
      if (classified) cards.push(classified);
    }
    return cards.length > 0 ? cards : null;
  }

  function scrapeBySetPageTerm() {
    const terms = document.querySelectorAll(
      "[class*='SetPageTerm-wordText'], [class*='TermText']"
    );
    const defs = document.querySelectorAll(
      "[class*='SetPageTerm-definitionText'], [class*='TermText']"
    );
    if (terms.length === 0 || defs.length === 0) return null;
    if (terms === defs) return null;

    const cards = [];
    const len = Math.min(terms.length, defs.length);
    for (let i = 0; i < len; i++) {
      const a = terms[i].textContent || "";
      const b = defs[i].textContent || "";
      const classified = classifyCard(a, b);
      if (classified) cards.push(classified);
    }
    return cards.length > 0 ? cards : null;
  }

  function scrapeByAriaAndRole() {
    const rows = document.querySelectorAll('[class*="SetPageTerm"]');
    if (rows.length === 0) return null;
    const cards = [];
    rows.forEach((row) => {
      const spans = row.querySelectorAll("span, div");
      const texts = [];
      spans.forEach((s) => {
        const t = s.textContent.trim();
        if (t.length > 0 && t.length < 200) texts.push(t);
      });
      if (texts.length >= 2) {
        const classified = classifyCard(texts[0], texts[1]);
        if (classified) cards.push(classified);
      }
    });
    return cards.length > 0 ? cards : null;
  }

  function scrapeByGenericPairs() {
    const allSpans = document.querySelectorAll(
      'span[class], div[class*="term"], div[class*="Term"]'
    );
    const chineseTexts = [];
    const otherTexts = [];
    allSpans.forEach((el) => {
      const t = el.textContent.trim();
      if (t.length > 0 && t.length < 200) {
        if (isChinese(t)) chineseTexts.push(t);
        else if (t.length > 1) otherTexts.push(t);
      }
    });
    if (chineseTexts.length === 0) return null;
    const cards = [];
    const len = Math.min(chineseTexts.length, otherTexts.length);
    for (let i = 0; i < len; i++) {
      cards.push({ chinese: chineseTexts[i], definition: otherTexts[i] });
    }
    return cards.length > 0 ? cards : null;
  }

  // --- Active flashcard detection (for /flashcards mode) ---

  function getActiveFlashcardText() {
    const strategies = [
      getFlashcardByFrontFace,
      getFlashcardByVisibleCard,
      getFlashcardByLargeText,
    ];

    for (const strategy of strategies) {
      const result = strategy();
      if (result) return result;
    }
    return null;
  }

  function getFlashcardByFrontFace() {
    const faces = document.querySelectorAll(
      '[class*="FlashcardFace"], [class*="flashcard-face"], [class*="CardFace"]'
    );
    if (faces.length === 0) return null;

    const visibleTexts = [];
    faces.forEach((face) => {
      const style = window.getComputedStyle(face);
      const isHidden =
        style.visibility === "hidden" ||
        style.display === "none" ||
        style.opacity === "0";
      if (!isHidden) {
        const text = face.textContent.trim();
        if (text.length > 0) visibleTexts.push(text);
      }
    });

    return visibleTexts.length > 0 ? visibleTexts[0] : null;
  }

  function getFlashcardByVisibleCard() {
    const cards = document.querySelectorAll(
      '[class*="FormattedText"], [class*="formattedText"], [class*="RichText"]'
    );
    if (cards.length === 0) return null;

    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.width > 100 && rect.height > 50 && rect.top >= 0 && rect.top < window.innerHeight) {
        const text = card.textContent.trim();
        if (text.length > 0 && text.length < 500) return text;
      }
    }
    return null;
  }

  function getFlashcardByLargeText() {
    const candidates = document.querySelectorAll(
      'div[class], span[class]'
    );
    let bestMatch = null;
    let bestArea = 0;

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (
        rect.width > 200 &&
        rect.height > 100 &&
        rect.top >= 0 &&
        rect.top < window.innerHeight &&
        area > bestArea
      ) {
        const text = el.textContent.trim();
        const childCount = el.children.length;
        if (text.length > 0 && text.length < 500 && childCount < 5) {
          bestMatch = text;
          bestArea = area;
        }
      }
    }
    return bestMatch;
  }

  // --- Core detection and messaging ---

  function detectAndSend() {
    const isFlashcardMode = /\/flashcards\/?/.test(window.location.pathname);

    if (isFlashcardMode) {
      detectFlashcardMode();
    } else {
      detectSetPage();
    }
  }

  function detectFlashcardMode() {
    const visibleText = getActiveFlashcardText();
    if (!visibleText || visibleText === lastSentText) return;

    lastSentText = visibleText;

    const allTerms = scrapeAllTermsFromFlashcardMode();

    let matchedCard = null;
    if (allTerms.length > 0) {
      matchedCard = allTerms.find(
        (card) =>
          card.chinese === visibleText.trim() ||
          card.definition === visibleText.trim()
      );
    }

    if (matchedCard) {
      sendCardUpdate({
        type: "CARD_CHANGED",
        chinese: matchedCard.chinese,
        definition: matchedCard.definition,
        visibleSide: isChinese(visibleText) ? "chinese" : "definition",
        totalCards: allTerms.length,
        allTerms: allTerms,
      });
    } else {
      sendCardUpdate({
        type: "CARD_CHANGED",
        visibleText: visibleText,
        visibleSide: isChinese(visibleText) ? "chinese" : "definition",
        chinese: isChinese(visibleText) ? visibleText : null,
        definition: !isChinese(visibleText) ? visibleText : null,
        totalCards: totalCards,
      });
    }
  }

  function scrapeAllTermsFromFlashcardMode() {
    const terms = scrapeAllTerms();
    if (terms.length > 0) {
      totalCards = terms.length;
      return terms;
    }

    // In flashcard mode the full list might not be in DOM.
    // Try getting data from embedded JSON (Quizlet often embeds set data in script tags).
    return scrapeFromEmbeddedJSON();
  }

  function scrapeFromEmbeddedJSON() {
    const scripts = document.querySelectorAll(
      'script[type="application/json"], script:not([src])'
    );
    for (const script of scripts) {
      try {
        const text = script.textContent;
        if (!text || !text.includes("term") || text.length > 500000) continue;

        const data = JSON.parse(text);
        const terms = extractTermsFromJSON(data);
        if (terms.length > 0) {
          totalCards = terms.length;
          return terms;
        }
      } catch (e) {
        // Not valid JSON or wrong structure
      }
    }
    return [];
  }

  function extractTermsFromJSON(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 8 || !obj || typeof obj !== "object") return [];

    if (Array.isArray(obj)) {
      // Check if this is an array of term objects
      const terms = [];
      for (const item of obj) {
        if (item && typeof item === "object" && item.word && item.definition) {
          const classified = classifyCard(item.word, item.definition);
          if (classified) terms.push(classified);
        }
        if (
          item &&
          typeof item === "object" &&
          item.term &&
          item.definition
        ) {
          const classified = classifyCard(item.term, item.definition);
          if (classified) terms.push(classified);
        }
      }
      if (terms.length > 0) return terms;

      // Recurse into array items
      for (const item of obj) {
        const result = extractTermsFromJSON(item, depth + 1);
        if (result.length > 0) return result;
      }
    } else {
      for (const key of Object.keys(obj)) {
        if (
          key === "terms" ||
          key === "cards" ||
          key === "studiableItems" ||
          key === "wordCards"
        ) {
          const result = extractTermsFromJSON(obj[key], depth + 1);
          if (result.length > 0) return result;
        }
      }
      for (const key of Object.keys(obj)) {
        const result = extractTermsFromJSON(obj[key], depth + 1);
        if (result.length > 0) return result;
      }
    }
    return [];
  }

  function detectSetPage() {
    const terms = scrapeAllTerms();
    if (terms.length > 0) {
      totalCards = terms.length;
      sendCardUpdate({
        type: "SET_LOADED",
        allTerms: terms,
        totalCards: terms.length,
      });
    }
  }

  function sendCardUpdate(data) {
    try {
      chrome.runtime.sendMessage(data);
    } catch (e) {
      // Extension context invalidated
    }
  }

  // --- Debounced observer callback ---

  function onMutation() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(detectAndSend, DEBOUNCE_MS);
  }

  // --- Message listener for requests from background/side panel ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "REQUEST_CURRENT_CARD") {
      lastSentText = "";
      detectAndSend();
      sendResponse({ ok: true });
    }
    if (message.type === "REQUEST_ALL_TERMS") {
      const terms = scrapeAllTerms();
      const embedded = scrapeFromEmbeddedJSON();
      const all = terms.length > 0 ? terms : embedded;
      sendResponse({ terms: all, totalCards: all.length });
    }
    return true;
  });

  // --- Initialize ---

  function init() {
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Initial detection after a short delay for page to settle
    setTimeout(detectAndSend, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
