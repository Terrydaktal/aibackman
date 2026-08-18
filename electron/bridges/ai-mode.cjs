const { readConversation, readConversations } = require('../archive/standard/reader.cjs');

function createAiModeBridge({
  db: aiDb,
  buildDeterministicId,
  ensureBridgeWindow,
  navigateBridgeTo,
  normalizeTitle: normalizeAiModeTitle,
  shouldShowWindow: shouldShowBridgeWindow,
  aiModeUrl: AI_MODE_URL,
  selectors,
}) {
  const {
    historyButton: AI_MODE_HISTORY_BUTTON_SELECTOR,
    historyDialog: AI_MODE_HISTORY_DIALOG_SELECTOR,
    historyItem: AI_MODE_HISTORY_ITEM_SELECTOR,
  } = selectors;
  const aiModeConversationRefs = new Map();
  const aiModeThreadIdToConversationId = new Map();

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

async function waitForWebContentsStable(win, timeoutMs = 2000) {
  if (!win || win.isDestroyed() || !win.webContents) return false;
  if (!win.webContents.isLoading()) return true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onLoad);
      win.webContents.removeListener('dom-ready', onLoad);
      resolve(value);
    };
    const onLoad = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    win.webContents.once('did-finish-load', onLoad);
    win.webContents.once('dom-ready', onLoad);
  });
}

async function getAiModeExecutionSnapshot(win) {
  if (!win || win.isDestroyed() || !win.webContents) return { error: 'bridge window unavailable' };
  const code = `
    (() => {
      const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
      };
      const countVisible = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).length;
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        scopedTurns: countVisible('[data-scope-id="turn"], .CKgc1d, [data-xid="aim-mars-turn-root"]'),
        users: countVisible('[data-xid="aim-mars-user-turn"], .VndcI.veK2kb, .VndcI, .user-message, [data-test-id="user-message"]'),
        assistants: countVisible('[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, .mZJni'),
        historyItems: countVisible(${JSON.stringify(AI_MODE_HISTORY_ITEM_SELECTOR)}),
        historyDialog: countVisible(${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)}),
        scrollY: window.scrollY,
        scrollHeight: document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0,
        bodyTextPreview: normalize(document.body?.innerText || '').slice(0, 500),
      };
    })();
  `;
  try {
    if (typeof win.webContents.executeJavaScriptInIsolatedWorld === 'function') {
      return await win.webContents.executeJavaScriptInIsolatedWorld(987, [{ code }], true);
    }
    return await win.webContents.executeJavaScript(code, true);
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

async function executeAiModeScript(win, script, { retries = 2, waitTimeoutMs = 2000, label = 'ai-mode-script' } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await win.webContents.executeJavaScript(script, true);
    } catch (error) {
      lastError = error;
      if (typeof win.webContents.executeJavaScriptInIsolatedWorld === 'function') {
        try {
          return await win.webContents.executeJavaScriptInIsolatedWorld(986, [{ code: script }], true);
        } catch (isolatedError) {
          lastError = isolatedError;
        }
      }
      const message = String(error?.message || error || '');
      const transient = /Script failed to execute|execution context was destroyed|Cannot find context|Object has been destroyed|Attempted to use a destroyed webContents|context was destroyed/i.test(message);
      if (!transient || attempt === retries) break;
      await waitForWebContentsStable(win, waitTimeoutMs);
      await sleep(200 * (attempt + 1));
    }
  }
  console.warn(`AI Mode script failed (${label}):`, {
    error: String(lastError?.message || lastError),
    snapshot: await getAiModeExecutionSnapshot(win),
  });
  throw lastError;
}

function deriveAiConversationId(ref) {
  const stableKey = String(ref?.threadId || '').trim()
    || `title:${String(ref?.title || '').trim().toLowerCase()}`;
  return `aimode-live-${buildDeterministicId(stableKey)}`;
}

function cleanupAiModeShadowConversations() {
  const convs = readConversations(aiDb);
  const byTitle = new Map();
  for (const conv of convs) {
    const t = normalizeAiModeTitle(conv.title || '').toLowerCase();
    if (!t) continue;
    if (!byTitle.has(t)) byTitle.set(t, []);
    byTitle.get(t).push(conv);
  }

  const toDelete = [];
  for (const [, group] of byTitle) {
    if (!Array.isArray(group) || group.length < 2) continue;
    const enriched = group.map((conv) => ({
      conv,
      messageCount: aiDb.countMessages(conv.id),
    }));
    const hasCanonicalWithMessages = enriched.some((row) => !String(row.conv.id).startsWith('aimode-live-') && row.messageCount > 0);
    if (!hasCanonicalWithMessages) continue;
    for (const row of enriched) {
      if (String(row.conv.id).startsWith('aimode-live-') && row.messageCount === 0) {
        toDelete.push(row.conv.id);
      }
    }
  }

  if (toDelete.length === 0) return 0;
  for (const id of toDelete) {
    aiDb.deleteConversation(id, {
      confirmation: id,
      reason: 'Remove a zero-message AI Mode shadow row after confirming a populated canonical row exists.',
      actor: 'ai-mode-shadow-reconciler',
    });
  }
  return toDelete.length;
}

async function resolveAiModeConversationRef(conversationId) {
  let ref = aiModeConversationRefs.get(conversationId) || null;
  if (ref) return ref;

  const currentConv = readConversation(aiDb, conversationId);
  const currentTitleNorm = normalizeAiModeTitle(currentConv?.title || '').toLowerCase();
  const refs = await fetchAiModeConversationIndex(2000);
  for (const row of refs) {
    const rowId = deriveAiConversationId(row);
    aiModeConversationRefs.set(rowId, { ...row });
    const rowThreadId = String(row.threadId || '').trim();
    if (rowThreadId && aiModeThreadIdToConversationId.get(rowThreadId) === conversationId) {
      ref = row;
    } else if (rowId === conversationId) {
      ref = row;
    } else if (!ref && currentTitleNorm && normalizeAiModeTitle(row.title || '').toLowerCase() === currentTitleNorm) {
      ref = row;
    }
    if (ref && rowThreadId) {
      aiModeThreadIdToConversationId.set(rowThreadId, conversationId);
    }
  }
  return ref;
}

async function ensureAiModeBridgeWindow() {
  const win = await ensureBridgeWindow();
  const waitForAiModeInteractive = async (timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await executeAiModeScript(
        win,
        `
          (() => {
            const visible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
              return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
            };
            const historyBtn = document.querySelector(${JSON.stringify(AI_MODE_HISTORY_BUTTON_SELECTOR)});
            const historyDialog = document.querySelector(${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)});
            const historyItem = document.querySelector(${JSON.stringify(AI_MODE_HISTORY_ITEM_SELECTOR)});
            const input = document.querySelector('textarea[aria-label="Ask anything"], [contenteditable="true"]');
            return {
              href: location.href,
              readyState: document.readyState,
              historyVisible: visible(historyBtn),
              historyDialogVisible: visible(historyDialog),
              historyItemVisible: visible(historyItem),
              inputVisible: visible(input),
            };
          })();
        `,
	        { retries: 2, waitTimeoutMs: 3000, label: 'wait-ai-mode-interactive' }
      );
      const url = String(state?.href || '');
      const ready = String(state?.readyState || '') === 'complete';
      if (url.includes('google.com/search') && ready && (state?.historyVisible || state?.historyDialogVisible || state?.historyItemVisible || state?.inputVisible)) {
        return true;
      }
      await sleep(200);
    }
    return false;
  };

  const currentUrl = String(win.webContents.getURL() || '');
  if (!currentUrl.includes('google.com/search')) {
    await navigateBridgeTo(AI_MODE_URL);
  }
  if (shouldShowBridgeWindow()) {
    try {
      win.setSkipTaskbar(false);
      win.show();
      win.focus();
    } catch {}
  }

  const nudgeFocusIfNeeded = async () => {
    if (!shouldShowBridgeWindow()) return;
    try {
      if (!win.isVisible()) win.show();
      if (!win.isFocused()) win.focus();
      await executeAiModeScript(
        win,
        `
          (() => {
            try { window.focus(); } catch {}
            const active = document.activeElement;
            if (active && typeof active.blur === 'function') {
              try { active.blur(); } catch {}
            }
            return true;
          })();
        `,
	        { retries: 1, waitTimeoutMs: 1500, label: 'nudge-ai-mode-focus' }
      );
    } catch {}
  };

  let ready = await waitForAiModeInteractive(30000);
  if (!ready) {
    await nudgeFocusIfNeeded();
    ready = await waitForAiModeInteractive(8000);
  }
  if (!ready) {
    try {
      await new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(done, 12000);
        win.webContents.once('did-finish-load', () => {
          clearTimeout(timer);
          done();
        });
        win.webContents.reloadIgnoringCache();
      });
    } catch {}
    await navigateBridgeTo(AI_MODE_URL);
    ready = await waitForAiModeInteractive(25000);
  }

  if (!ready) {
    throw new Error('AI Mode bridge is not interactive yet');
  }
  return win;
}

async function getGoogleAccountIdentity() {
  try {
    const win = await ensureAiModeBridgeWindow();
    const identity = await executeAiModeScript(
      win,
      `
        (() => {
          const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i;
          const values = [];
          const add = (value) => {
            const text = String(value || '').trim();
            if (text) values.push(text);
          };
          for (const element of document.querySelectorAll('[data-email], [aria-label], [title], a[href], button')) {
            add(element.getAttribute('data-email'));
            add(element.getAttribute('aria-label'));
            add(element.getAttribute('title'));
            if (element.tagName === 'A') add(element.getAttribute('href'));
          }
          add(document.body?.innerText || '');
          const email = values.map((value) => value.match(emailPattern)?.[0] || '')
            .find(Boolean) || '';
          return email ? { email } : null;
        })();
      `,
      { retries: 1, waitTimeoutMs: 2000, label: 'read-google-account-identity' }
    );
    return identity && typeof identity.email === 'string' ? identity : null;
  } catch {
    return null;
  }
}

async function fetchAiModeConversationIndex(limit = 100) {
  const win = await ensureAiModeBridgeWindow();
  const rows = await executeAiModeScript(
    win,
    `
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        };
        const historySelector = ${JSON.stringify(AI_MODE_HISTORY_BUTTON_SELECTOR)};
        const historyDialogSelector = ${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)};
        const itemSelector = ${JSON.stringify(AI_MODE_HISTORY_ITEM_SELECTOR)};
        const maxItems = ${JSON.stringify(Math.max(1, Number(limit) || 100))};
        const clickElement = (el) => {
          if (!el) return false;
          const init = { bubbles: true, cancelable: true, view: window };
          try { el.dispatchEvent(new PointerEvent('pointerdown', init)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mousedown', init)); } catch {}
          try { el.dispatchEvent(new PointerEvent('pointerup', init)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mouseup', init)); } catch {}
          try { el.click(); } catch {}
          return true;
        };
        const historyItems = () => Array.from(document.querySelectorAll(itemSelector)).filter(visible);
        const historyReady = () => {
          if (historyItems().length > 0) return true;
          const dialog = document.querySelector(historyDialogSelector);
          const empty = Array.from(document.querySelectorAll('.gNJflc, [role="heading"]'))
            .some((el) => visible(el) && normalize(el.textContent || '') === 'No AI Mode history');
          return visible(dialog) && empty;
        };

        const historyButton = document.querySelector(historySelector);
        if (!historyReady() && historyButton && visible(historyButton)) {
          for (let attempt = 0; attempt < 30; attempt += 1) {
            const dialog = document.querySelector(historyDialogSelector);
            if (!visible(dialog)) {
              clickElement(historyButton);
              await sleep(300);
            } else {
              await sleep(250);
            }
            if (historyReady()) break;
          }
        }
        for (let attempt = 0; attempt < 50 && !historyReady(); attempt += 1) {
          await sleep(120);
        }

        for (let i = 0; i < 80; i += 1) {
          const showMore = Array.from(document.querySelectorAll('button')).find((b) => {
            const label = normalize(b.getAttribute('aria-label') || b.textContent || '');
            if (!label) return false;
            return (
              label.includes('See more AI Mode') ||
              label.includes('See more') ||
              label.includes('Show more') ||
              b.classList.contains('EBNOJf')
            );
          });
          if (!showMore || !visible(showMore)) break;
          showMore.scrollIntoView({ block: 'center' });
          await sleep(140);
          clickElement(showMore);
          await sleep(700);
          const count = historyItems().length;
          if (count >= maxItems) break;
        }

        const list = [];
        const seen = new Set();
        const items = historyItems();
        let visualIndex = 0;
        for (const el of items) {
          const threadId = normalize(el.getAttribute('data-thread-id') || '');
          const title = normalize(el.innerText || el.getAttribute('aria-label') || '');
          if (!title) continue;
          const key = threadId || ('title:' + title.toLowerCase());
          if (seen.has(key)) continue;
          seen.add(key);
          list.push({
            threadId,
            title,
            visualIndex,
          });
          visualIndex += 1;
          if (list.length >= maxItems) break;
        }
        return list;
      })();
    `,
	    { retries: 2, waitTimeoutMs: 3000, label: 'fetch-ai-mode-index' }
  );
  return Array.isArray(rows) ? rows : [];
}

async function openAiModeConversation(ref) {
  if (!ref) return false;
  const win = await ensureAiModeBridgeWindow();
  if (shouldShowBridgeWindow()) {
    try {
      if (!win.isVisible()) win.show();
      if (!win.isFocused()) win.focus();
    } catch {}
  }
  try {
      await executeAiModeScript(
        win,
        `
          (() => {
            try { window.focus(); } catch {}
            return true;
          })();
        `,
	        { retries: 1, waitTimeoutMs: 1500, label: 'open-ai-mode-focus' }
      );
  } catch {}
  await sleep(200);
  const attemptOpen = async () => executeAiModeScript(
    win,
    `
      (() => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const normalizeTitle = (v) => String(v || '')
          .replace(/\\s+/g, ' ')
          .replace(/^Searched for\\s+/i, '')
          .trim();
        const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const visible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        };
        const threadId = ${JSON.stringify(String(ref.threadId || ''))};
        const targetTitle = normalizeTitle(${JSON.stringify(String(ref.title || ''))});
        const index = Number(${JSON.stringify(Number(ref.visualIndex))});
        const itemSelector = ${JSON.stringify(AI_MODE_HISTORY_ITEM_SELECTOR)};
        const historySelector = ${JSON.stringify(AI_MODE_HISTORY_BUTTON_SELECTOR)};
        const historyDialogSelector = ${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)};
        const clickElement = (el) => {
          if (!el) return false;
          const init = { bubbles: true, cancelable: true, view: window };
          try { el.dispatchEvent(new PointerEvent('pointerdown', init)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mousedown', init)); } catch {}
          try { el.dispatchEvent(new PointerEvent('pointerup', init)); } catch {}
          try { el.dispatchEvent(new MouseEvent('mouseup', init)); } catch {}
          try { el.click(); } catch {}
          return true;
        };

        const clickableItems = () => {
          const raw = Array.from(document.querySelectorAll(itemSelector)).filter(visible);
          return raw.filter((el) => {
            const tag = String(el.tagName || '').toUpperCase();
            return tag === 'BUTTON' || el.getAttribute('role') === 'button' || typeof el.click === 'function';
          });
        };
        const noHistoryVisible = () => Array.from(document.querySelectorAll('.gNJflc, [role="heading"]'))
          .some((el) => visible(el) && normalize(el.textContent || '') === 'No AI Mode history');
        const drawerVisible = () => visible(document.querySelector(historyDialogSelector));

        const ensureHistoryOpen = async () => {
          if (clickableItems().length > 0) return true;
          for (let attempt = 0; attempt < 50; attempt += 1) {
            const historyButton = document.querySelector(historySelector);
            if (historyButton && visible(historyButton) && !drawerVisible()) {
              try { historyButton.scrollIntoView({ block: 'center' }); } catch {}
              clickElement(historyButton);
              await sleep(300);
            }
            if (clickableItems().length > 0) return true;
            if (drawerVisible() && noHistoryVisible()) return false;
            await sleep(200);
          }
          return clickableItems().length > 0;
        };

        const pickTarget = () => {
          const items = clickableItems();
          let target = null;
          if (threadId) {
            target = items.find((el) => normalize(el.getAttribute('data-thread-id') || '') === threadId) || null;
          }
          if (!target && targetTitle) {
            target = items.find((el) => {
              const title = normalizeTitle(el.innerText || el.getAttribute('aria-label') || '');
              if (!title) return false;
              return title === targetTitle || title.includes(targetTitle) || targetTitle.includes(title);
            }) || null;
          }
          if (!target && Number.isInteger(index) && index >= 0 && index < items.length) {
            target = items[index];
          }
          return target || null;
        };

        const tryExpand = async () => {
          const showMore = Array.from(document.querySelectorAll('button')).find((b) => {
            const label = normalize(b.getAttribute('aria-label') || b.textContent || '');
            if (!label) return false;
            return (
              label.includes('See more AI Mode') ||
              label.includes('See more') ||
              label.includes('Show more') ||
              b.classList.contains('EBNOJf')
            );
          });
          if (!showMore || !visible(showMore)) return false;
          showMore.scrollIntoView({ block: 'center' });
          await sleep(120);
          clickElement(showMore);
          await sleep(420);
          return true;
        };

        return (async () => {
          const historyReady = await ensureHistoryOpen();
          if (!historyReady) return false;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const target = pickTarget();
            if (target) {
              target.scrollIntoView({ block: 'center' });
              await sleep(80);
              clickElement(target);
              return true;
            }
            const expanded = await tryExpand();
            if (!expanded) break;
          }
          return false;
        })();
      })();
    `,
	    { retries: 2, waitTimeoutMs: 3000, label: 'open-ai-mode-history-item' }
  );

  let opened = await attemptOpen();
  if (!opened) {
    try {
      await new Promise((resolve) => {
        const done = () => resolve();
        const timer = setTimeout(done, 12000);
        win.webContents.once('did-finish-load', () => {
          clearTimeout(timer);
          done();
        });
        win.webContents.reloadIgnoringCache();
      });
    } catch {}
    await ensureAiModeBridgeWindow();
    opened = await attemptOpen();
  }
  if (!opened) return false;

  try {
    await executeAiModeScript(
      win,
      `
        (async () => {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
          };
          const dialogSelector = ${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)};
          const closeDrawer = () => {
            const dialog = document.querySelector(dialogSelector);
            if (!visible(dialog)) return true;
            const back = dialog.querySelector('button[aria-label="Back"], [role="button"][aria-label="Back"]');
            if (back && visible(back)) {
              try { back.click(); } catch {}
              return false;
            }
            try {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
            } catch {}
            return false;
          };
          for (let i = 0; i < 12; i += 1) {
            if (closeDrawer()) return true;
            await sleep(180);
          }
          return !visible(document.querySelector(dialogSelector));
        })();
      `,
	      { retries: 1, waitTimeoutMs: 1500, label: 'close-ai-mode-history-drawer' }
    );
  } catch {}

  const getAiModeBridgeSnapshot = async () => {
    try {
      return await executeAiModeScript(
        win,
        `
          (() => {
            const normalize = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
            const visible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
              return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
            };
            const countVisible = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).length;
            return {
              href: location.href,
              title: document.title,
              readyState: document.readyState,
              scopedTurns: countVisible('[data-scope-id="turn"], .CKgc1d, [data-xid="aim-mars-turn-root"]'),
              users: countVisible('[data-xid="aim-mars-user-turn"], .VndcI.veK2kb, .VndcI, .user-message, [data-test-id="user-message"]'),
              assistants: countVisible('[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, .mZJni'),
              historyDialog: countVisible(${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)}),
              scrollY: window.scrollY,
              scrollHeight: document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0,
              bodyTextPreview: normalize(document.body?.innerText || '').slice(0, 800),
            };
          })();
        `,
	        { retries: 1, waitTimeoutMs: 1500, label: 'ai-mode-open-snapshot' }
      );
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  };

  const settleDeadline = Date.now() + 15000;
  while (Date.now() < settleDeadline) {
    const ready = await executeAiModeScript(
      win,
      `
        (() => {
          const visible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
          };
	          const historyDialog = document.querySelector(${JSON.stringify(AI_MODE_HISTORY_DIALOG_SELECTOR)});
	          const turns = Array.from(document.querySelectorAll('[data-xid="aim-mars-turn-root"], [data-scope-id="turn"], .CKgc1d')).filter(visible);
	          const users = Array.from(document.querySelectorAll('[data-xid="aim-mars-user-turn"], .VndcI.veK2kb, .VndcI, [role="heading"]')).filter((el) => {
	            if (!visible(el)) return false;
	            if (historyDialog && historyDialog.contains(el)) return false;
	            const text = String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
	            return !!text && text !== 'AI Mode history' && text !== 'Recent' && text !== 'No AI Mode history';
	          });
	          const ai = Array.from(document.querySelectorAll('[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, .mZJni')).filter((el) => {
	            if (!visible(el)) return false;
	            if (historyDialog && historyDialog.contains(el)) return false;
	            return !!String(el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
	          });
	          return turns.length > 0 || users.length > 0 || ai.length > 0;
	        })();
      `,
	      { retries: 2, waitTimeoutMs: 3000, label: 'wait-ai-mode-readable-content' }
    );
    if (ready) return true;
    await sleep(160);
  }
  console.warn('AI Mode opened but readable chat content was not detected:', await getAiModeBridgeSnapshot());
  return false;
}

async function scrapeAiModeMessagesFromBridge() {
  const win = await ensureAiModeBridgeWindow();
  const turnsPayload = await executeAiModeScript(
    win,
    `
      (async () => {
        try {
          const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          const normalize = (v) => String(v || '')
            .replace(/\\u00a0/g, ' ')
            .replace(/\\r/g, '')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
          };

        const turnSelector = '[data-xid="aim-mars-turn-root"]';
        const scopedTurnSelector = '[data-scope-id="turn"], .CKgc1d, [data-xid="aim-mars-turn-root"]';
        const userSelector = '[data-xid="aim-mars-user-turn"], .VndcI.veK2kb, .VndcI, .user-message, [data-test-id="user-message"]';
        const aiSelector = '[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, .Y3BBE, .mZJni';
        const aiContainerSelector = '[data-xid="VpUvz"], .model-response-text, .markdown, .message-content, response-container, model-response';
        const ignoredUserPhrases = new Set([
          'Delete all searches?',
          'Delete this search?',
          'AI Mode history',
          'No AI Mode history',
          'Recent',
          'My Ad Centre',
          'Sign in',
          'Settings',
          'Privacy',
          'Terms',
        ]);

        const getScrollableAncestor = (node) => {
          let current = node ? node.parentElement : null;
          while (current && current !== document.body) {
            const style = window.getComputedStyle(current);
            const overflowY = String(style?.overflowY || '').toLowerCase();
            if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight + 20) {
              return current;
            }
            current = current.parentElement;
          }
          return document.scrollingElement || document.documentElement;
        };
        const describeScroller = (node) => {
          if (!node) return 'none';
          if (node === document.body) return 'body';
          if (node === document.documentElement) return 'documentElement';
          if (node === document.scrollingElement) return 'scrollingElement';
          const tag = String(node.tagName || '').toLowerCase();
          const cls = String(node.className || '').replace(/\\s+/g, '.').slice(0, 80);
          const xid = node.getAttribute && node.getAttribute('data-xid');
          return [tag, cls ? '.' + cls : '', xid ? '[data-xid="' + xid + '"]' : ''].join('');
        };

        const getNodeText = (node) => normalize(node?.innerText || node?.textContent || '');
        const results = [];

        const collapseConsecutiveDuplicates = (items) => {
          const out = [];
          let last = null;
          for (const item of items) {
            const fp = item.role + '|' + item.content;
            if (fp === last) continue;
            out.push(item);
            last = fp;
          }
          return out;
        };

        const cleanAssistantText = (raw) => {
          return normalize(String(raw || '')
            .replace(/AI responses may include mistakes\\.\\s*Learn more/gi, '')
            .replace(/Good response\\s*Bad response\\s*More/gi, '')
            .replace(/Copy\\s*Share\\s*Good response\\s*Bad response\\s*More/gi, '')
          );
        };

        const tableToMarkdown = (tableEl) => {
          if (!tableEl) return '';
          const rows = Array.from(tableEl.querySelectorAll('tr')).map((tr) => {
            const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) => {
              return normalize(cell.innerText || cell.textContent || '').replace(/\|/g, '\\|');
            });
            return cells;
          }).filter((cells) => cells.length > 0 && cells.some((v) => !!v));
          if (rows.length === 0) return '';
          const colCount = rows.reduce((max, cells) => Math.max(max, cells.length), 0);
          const normalizeRow = (cells) => {
            const out = cells.slice(0, colCount);
            while (out.length < colCount) out.push('');
            return out;
          };
          const header = normalizeRow(rows[0]);
          const body = rows.slice(1).map(normalizeRow);
          const divider = Array(colCount).fill('---');
          const lines = [];
          lines.push('| ' + header.join(' | ') + ' |');
          lines.push('| ' + divider.join(' | ') + ' |');
          for (const row of body) lines.push('| ' + row.join(' | ') + ' |');
          return lines.join('\\n');
        };

        const extractAssistantContent = (assistantNode) => {
          if (!assistantNode) return '';
          const hasTable = !!assistantNode.querySelector('table');
          if (!hasTable) return cleanAssistantText(getNodeText(assistantNode));

          const clone = assistantNode.cloneNode(true);
          const noiseSelectors = [
            'button',
            '[role="button"]',
            '.txxDge',
            '.YHsVn',
            '.RkJvxe',
            '.UrecDd',
            '.YOTKvb',
            '.HvurC',
            '.rBl3me',
            'script',
            'style',
            'svg',
          ];
          clone.querySelectorAll(noiseSelectors.join(',')).forEach((el) => el.remove());

          const tables = Array.from(clone.querySelectorAll('table'));
          for (const table of tables) {
            const md = tableToMarkdown(table);
            const replacement = document.createTextNode(md ? ('\\n\\n' + md + '\\n\\n') : '\\n');
            table.replaceWith(replacement);
          }

          const mount = document.createElement('div');
          mount.style.position = 'fixed';
          mount.style.left = '-99999px';
          mount.style.top = '0';
          mount.style.opacity = '0';
          mount.style.pointerEvents = 'none';
          mount.appendChild(clone);
          document.body.appendChild(mount);
          const extracted = cleanAssistantText(getNodeText(clone));
          mount.remove();
          return extracted;
        };

        const deriveTurnDomKey = (turn, fallbackSeq) => {
          if (!turn) return 'turn-fallback-' + String(fallbackSeq);
          const keys = [
            turn.getAttribute('data-suuid'),
            turn.getAttribute('data-turn-id'),
            turn.getAttribute('data-message-id'),
            turn.getAttribute('data-thread-id'),
            turn.getAttribute('jsuid'),
            turn.id,
          ].map((v) => normalize(v)).filter(Boolean);
          if (keys.length > 0) return keys[0];
          return 'turn-fallback-' + String(fallbackSeq);
        };

        const clickExpandableButtons = () => {
          const buttons = Array.from(document.querySelectorAll('button')).filter((btn) => isVisible(btn));
          let clicks = 0;
          for (const btn of buttons) {
            const label = normalize((btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase());
            if (!label) continue;
            if (!/(show more|see more|read more|more)/i.test(label)) continue;
            if (label.includes('ai mode history')) continue;
            if (label.includes('delete this search') || label.includes('delete all searches')) continue;
            try {
              btn.click();
              clicks += 1;
            } catch {}
          }
          return clicks;
        };

        const collectFromTurnRoots = (sampleTop) => {
          const pairs = [];
          const pairKeys = new Set();
          const turnRoots = Array.from(document.querySelectorAll(turnSelector))
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

          for (const turn of turnRoots) {
            const userCandidates = Array.from(turn.querySelectorAll(userSelector));
            const aiCandidates = Array.from(turn.querySelectorAll(aiSelector));

            const userTextRaw = userCandidates
              .map((el) => getNodeText(el))
              .find(Boolean) || '';
            const aiTextRaw = aiCandidates
              .map((el) => getNodeText(el))
              .filter(Boolean)
              .pop() || '';

            if (!userTextRaw && !aiTextRaw) continue;
            const key = userTextRaw + '\\n---\\n' + aiTextRaw;
            if (pairKeys.has(key)) continue;
            pairKeys.add(key);
            const baseOrder = sampleTop + turn.getBoundingClientRect().top;
            if (userTextRaw) pairs.push({ role: 'user', content: userTextRaw, order: baseOrder + 0.001 });
            if (aiTextRaw) pairs.push({ role: 'assistant', content: aiTextRaw, order: baseOrder + 0.002 });
          }
          return pairs;
        };

        const collectFromScopedTurns = (sampleTop) => {
          const rows = [];
          const allTurnNodes = Array.from(document.querySelectorAll(scopedTurnSelector)).filter((node) => isVisible(node));
          const scopedTurns = allTurnNodes.filter((node) => node.matches('[data-scope-id="turn"]'));
          const turnNodes = scopedTurns.length > 0 ? scopedTurns : allTurnNodes;
          const topLevelTurns = turnNodes.filter((node) => !turnNodes.some((other) => other !== node && other.contains(node)));
          const orderedTurns = topLevelTurns.sort((a, b) => {
            if (a === b) return 0;
            const pos = a.compareDocumentPosition(b);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
          });

          let seq = 0;
          for (const turn of orderedTurns) {
            const turnDomKey = deriveTurnDomKey(turn, seq);
            const userCandidates = Array.from(turn.querySelectorAll('.VndcI.veK2kb, [data-xid="aim-mars-user-turn"], .user-message, [data-test-id="user-message"]'))
              .filter((el) => {
                if (!el || !isVisible(el)) return false;
                // Guard against assistant content headings being treated as user turns.
                return !el.closest('[data-xid="VpUvz"], .mZJni.Dn7Fzd, .model-response-text, .markdown, .message-content');
              });
            const assistantCandidate = turn.querySelector('[data-xid="VpUvz"], .mZJni.Dn7Fzd, .model-response-text, .markdown, .message-content');

            const userText = userCandidates
              .map((el) => getNodeText(el))
              .filter(Boolean)
              .sort((a, b) => b.length - a.length)[0] || '';
            const assistantText = assistantCandidate ? extractAssistantContent(assistantCandidate) : '';

            if (!userText && !assistantText) continue;
            const baseOrder = sampleTop + turn.getBoundingClientRect().top + (seq * 0.01);
            const turnFingerprint = normalize(userText + '\\n---\\n' + assistantText).slice(0, 400);
            const scopedKey = (String(turnDomKey || '').startsWith('turn-fallback-') ? '' : String(turnDomKey || '')) || ('fp:' + turnFingerprint);
            if (userText) rows.push({ role: 'user', content: userText, order: baseOrder + 0.001, sourceKey: scopedKey + '|user', turnKey: scopedKey });
            if (assistantText) rows.push({ role: 'assistant', content: assistantText, order: baseOrder + 0.002, sourceKey: scopedKey + '|assistant', turnKey: scopedKey });
            seq += 1;
          }
          return rows;
        };

        const collectFromGlobalDom = (sampleTop) => {
          const rawUserNodes = Array.from(document.querySelectorAll(userSelector));
          const userNodes = rawUserNodes.filter((node) => {
            if (!node || !isVisible(node)) return false;
            if (node.closest(aiContainerSelector)) return false;
            const text = getNodeText(node);
            if (!text) return false;
            if (ignoredUserPhrases.has(text)) return false;
            if (/^hi[, ]+lewis[, ]+what is on your mind/i.test(text)) return false;
            return !rawUserNodes.some((other) => other !== node && other.contains(node));
          });

          const rawAiNodes = Array.from(document.querySelectorAll(aiSelector));
          const aiNodes = rawAiNodes.filter((node) => {
            if (!node || !isVisible(node)) return false;
            const hasAiAncestor = rawAiNodes.some((other) => other !== node && other.contains(node));
            if (hasAiAncestor) return false;
            const isOrContainsUser = userNodes.some((u) => node === u || node.contains(u));
            if (isOrContainsUser) return false;
            const text = getNodeText(node);
            return !!text;
          });

          const mergedNodes = [];
          for (const node of userNodes) mergedNodes.push({ role: 'user', node });
          for (const node of aiNodes) mergedNodes.push({ role: 'assistant', node });

          mergedNodes.sort((a, b) => {
            if (a.node === b.node) return 0;
            const pos = a.node.compareDocumentPosition(b.node);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
          });

          const items = [];
          for (let i = 0; i < mergedNodes.length; i += 1) {
            const { role, node } = mergedNodes[i];
            let content = getNodeText(node);
            if (role === 'assistant') content = content.replace(/Show drafts\\s*$/i, '').trim();
            if (!content) continue;
            const order = sampleTop + node.getBoundingClientRect().top + (i * 0.0001);
            items.push({ role, content, order, sourceKey: '' });
          }
          return items;
        };

	          const firstTurn = document.querySelector(scopedTurnSelector) || document.querySelector(turnSelector) || document.querySelector(aiSelector) || document.querySelector(userSelector);
	          const scroller = getScrollableAncestor(firstTurn);
          const usesWindowScroll = scroller === document.body || scroller === document.documentElement || scroller === document.scrollingElement;
          const getTop = () => usesWindowScroll ? window.scrollY : scroller.scrollTop;
          const setTop = (value) => {
            if (usesWindowScroll) {
              window.scrollTo(0, value);
            } else {
              scroller.scrollTop = value;
            }
          };
          const getClientHeight = () => usesWindowScroll ? window.innerHeight : scroller.clientHeight;
          const getScrollHeight = () => usesWindowScroll
            ? (document.scrollingElement?.scrollHeight || document.documentElement.scrollHeight || 0)
            : scroller.scrollHeight;

          let maxTop = Math.max(0, getScrollHeight() - getClientHeight());
          const sampleAtCurrentScroll = () => {
            const scoped = collectFromScopedTurns(getTop());
            if (scoped.length > 0) {
              results.push(...scoped);
            } else {
              results.push(...collectFromTurnRoots(getTop()));
              results.push(...collectFromGlobalDom(getTop()));
            }
          };
          const settleAtBottom = async () => {
            let lastMaxTop = -1;
            let stablePasses = 0;
            for (let attempt = 0; attempt < 10; attempt += 1) {
              setTop(maxTop);
              await sleep(180);
              clickExpandableButtons();
              await sleep(120);
              sampleAtCurrentScroll();

              const currentMaxTop = Math.max(0, getScrollHeight() - getClientHeight());
              const atBottom = Math.abs(getTop() - currentMaxTop) <= 2;
              if (currentMaxTop === maxTop && atBottom && currentMaxTop === lastMaxTop) {
                stablePasses += 1;
              } else {
                stablePasses = 0;
              }
              lastMaxTop = currentMaxTop;
              maxTop = Math.max(maxTop, currentMaxTop);
              if (stablePasses >= 2) break;
            }
          };

          setTop(0);
          await sleep(120);
          clickExpandableButtons();
          await sleep(80);
          sampleAtCurrentScroll();

          let guard = 0;
          while (getTop() < maxTop - 2 && guard < 320) {
            const next = Math.min(maxTop, getTop() + Math.max(200, Math.floor(getClientHeight() * 0.82)));
            if (next <= getTop() + 1) break;
            setTop(next);
            await sleep(140);
            clickExpandableButtons();
            await sleep(80);
            sampleAtCurrentScroll();
            maxTop = Math.max(maxTop, Math.max(0, getScrollHeight() - getClientHeight()));
            guard += 1;
          }

          if (maxTop > 0) {
            await settleAtBottom();
          }

          const normalized = [];
          const hasTurnKeys = results.some((row) => normalize(row?.turnKey || ''));
          if (hasTurnKeys) {
            const buckets = new Map();
            for (const row of results) {
              if (!row) continue;
              const turnKey = normalize(row?.turnKey || '');
              if (!turnKey) continue;
              const role = row?.role === 'assistant' ? 'assistant' : 'user';
              const content = normalize(row?.content || '');
              if (!content) continue;
              const order = Number.isFinite(Number(row?.order)) ? Number(row.order) : Number.MAX_SAFE_INTEGER;
              let bucket = buckets.get(turnKey);
              if (!bucket) {
                bucket = { order, user: '', assistant: '' };
                buckets.set(turnKey, bucket);
              } else if (order < bucket.order) {
                bucket.order = order;
              }
              if (role === 'user') {
                if (!bucket.user || content.length >= bucket.user.length) bucket.user = content;
              } else {
                if (!bucket.assistant || content.length >= bucket.assistant.length) bucket.assistant = content;
              }
            }
            const mergedTurns = Array.from(buckets.values()).sort((a, b) => a.order - b.order);
            for (const turn of mergedTurns) {
              if (turn.user) normalized.push({ role: 'user', content: turn.user });
              if (turn.assistant) normalized.push({ role: 'assistant', content: turn.assistant });
            }
          } else {
            const ordered = [];
            const seenSourceKeys = new Set();
            for (const row of results) {
              if (!row) continue;
              const sourceKey = normalize(row?.sourceKey || '');
              if (sourceKey && seenSourceKeys.has(sourceKey)) continue;
              if (sourceKey) seenSourceKeys.add(sourceKey);
              ordered.push(row);
            }
            for (const row of ordered) {
              const role = row?.role === 'assistant' ? 'assistant' : 'user';
              const content = normalize(row?.content || '');
              if (!content) continue;
              normalized.push({ role, content });
            }
          }

	          return {
	            ok: true,
	            data: collapseConsecutiveDuplicates(normalized),
	            debug: {
	              href: location.href,
	              title: document.title,
	              readyState: document.readyState,
	              scopedTurnCount: document.querySelectorAll(scopedTurnSelector).length,
	              turnRootCount: document.querySelectorAll(turnSelector).length,
	              userCount: document.querySelectorAll(userSelector).length,
	              assistantCount: document.querySelectorAll(aiSelector).length,
	              rawResultCount: results.length,
	              normalizedCount: normalized.length,
	              scroller: describeScroller(scroller),
	              scrollTop: getTop(),
	              scrollHeight: getScrollHeight(),
	              clientHeight: getClientHeight(),
	              bodyTextPreview: normalize(document.body?.innerText || '').slice(0, 800),
	            },
	          };
        } catch (error) {
          return { ok: false, error: String(error && (error.stack || error.message || error)) };
        }
      })();
    `,
	    { retries: 2, waitTimeoutMs: 3000, label: 'scrape-ai-mode-messages' }
  );
  if (turnsPayload && typeof turnsPayload === 'object' && turnsPayload.ok === true && Array.isArray(turnsPayload.data)) {
    if (turnsPayload.data.length === 0) {
      console.warn('AI Mode scrape returned zero messages:', turnsPayload.debug || {});
    }
    return turnsPayload.data;
  }
  if (turnsPayload && typeof turnsPayload === 'object' && turnsPayload.ok === false) {
    throw new Error(`AI Mode scrape script error: ${turnsPayload.error || 'unknown'}`);
  }
  return [];
}

  return {
    cleanupShadowConversations: cleanupAiModeShadowConversations,
    conversationRefs: aiModeConversationRefs,
    deriveConversationId: deriveAiConversationId,
    ensureWindow: ensureAiModeBridgeWindow,
    getAccountIdentity: getGoogleAccountIdentity,
    fetchConversationIndex: fetchAiModeConversationIndex,
    openConversation: openAiModeConversation,
    resolveConversationRef: resolveAiModeConversationRef,
    scrapeMessages: scrapeAiModeMessagesFromBridge,
    threadIdToConversationId: aiModeThreadIdToConversationId,
  };
}

module.exports = createAiModeBridge;
