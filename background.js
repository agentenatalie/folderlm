// ========================================
// FolderLM - Background Script
// ========================================

const NOTEBOOKLM_HOST = 'notebooklm.google.com';

function isNotebookLmTab(tab) {
  if (!tab || !tab.url) return false;
  try {
    return new URL(tab.url).hostname === NOTEBOOKLM_HOST;
  } catch {
    return false;
  }
}

async function openPanelForTab(tab) {
  if (!tab?.id || !isNotebookLmTab(tab)) return;
  await chrome.sidePanel.open({ tabId: tab.id });
}

chrome.action.onClicked.addListener((tab) => {
  openPanelForTab(tab).catch((error) => {
    console.error('Failed to open side panel:', error);
  });
});

chrome.sidePanel.setPanelBehavior({
  openPanelOnActionClick: false
});
