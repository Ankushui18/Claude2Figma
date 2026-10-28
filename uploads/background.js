"use strict";
(() => {
  // src/content/sondaDeck.ts
  var SELETOR_DECK_STAGE = "deck-stage";
  function lerDeckDaPagina(seletorStage) {
    const stage = document.querySelector(seletorStage);
    if (!stage) return { formato: "pagina-unica" };
    const secoes = Array.from(stage.children).filter((e) => e.tagName === "SECTION");
    return {
      formato: "slides",
      slides: secoes.length,
      rotulos: secoes.map((s) => (s.getAttribute("data-label") ?? "").trim())
    };
  }

  // ../shared/stores.ts
  var CLAUDE_DESIGN_URL = "https://claude.ai/design";

  // src/background.ts
  chrome.runtime.onInstalled.addListener((detalhes) => {
    if (detalhes.reason !== "install") return;
    void chrome.tabs.create({ url: CLAUDE_DESIGN_URL });
  });
  var CLAUDE_HOST_FRAGMENT = "claudeusercontent.com";
  async function findClaudeSlideFrameId(tabId) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    const match = frames?.find((frame) => frame.url.includes(CLAUDE_HOST_FRAGMENT));
    return match ? match.frameId : null;
  }
  var pendingResolve = null;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "capture-result" && pendingResolve) {
      pendingResolve(message.payload);
      pendingResolve = null;
    }
  });
  async function captureActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false, error: "Nenhuma aba ativa encontrada." };
    const frameId = await findClaudeSlideFrameId(tab.id);
    if (frameId === null) {
      return { ok: false, error: "N\xE3o encontrei o slide nessa p\xE1gina." };
    }
    const resultPromise = new Promise((resolve) => {
      pendingResolve = resolve;
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [frameId] },
      files: ["dist/inject.js"]
    });
    const result = await resultPromise;
    if (result.ok && tab.title) {
      return { ...result, title: tab.title };
    }
    return result;
  }
  async function probeActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { ok: false };
    const frameId = await findClaudeSlideFrameId(tab.id);
    if (frameId === null) return { ok: false };
    const title = (tab.title ?? "").trim();
    try {
      const [injecao] = await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [frameId] },
        func: lerDeckDaPagina,
        args: [SELETOR_DECK_STAGE]
      });
      const deck = injecao?.result;
      return { ok: true, title, ...deck ?? { formato: "pagina-unica" } };
    } catch {
      return { ok: true, title, formato: "pagina-unica" };
    }
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "probe") return void 0;
    probeActiveTab().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "capture") return void 0;
    captureActiveTab().then(sendResponse).catch((error) => sendResponse({ ok: false, error: `Falha ao capturar: ${String(error)}` }));
    return true;
  });
})();
