// ========================================
// FolderLM - Popup Script
// ========================================

const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
const STORAGE_KEY = 'folderlmWorkspaceState';

async function getState() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  return result[STORAGE_KEY] || {};
}

async function setState(nextState) {
  await chrome.storage.local.set({ [STORAGE_KEY]: nextState });
}

async function clearState() {
  await chrome.storage.local.remove([STORAGE_KEY]);
}

document.addEventListener('DOMContentLoaded', () => {
  const byId = (id) => document.getElementById(id);
  const on = (id, event, handler) => byId(id).addEventListener(event, handler);
  const bindClick = (id, handler) => on(id, 'click', handler);

  loadAndApplyTheme();
  loadStats();

  bindClick('btn-refresh-stats', refreshStats);
  bindClick('btn-slide-prompt', openSlidePromptModal);
  bindClick('btn-export', exportData);
  bindClick('btn-open-sidepanel', openSidePanel);
  bindClick('btn-open-notebooklm', openNotebookLM);
  bindClick('btn-reset', resetData);

  bindClick('btn-import', () => byId('import-file').click());
  on('import-file', 'change', importData);

  bindClick('modal-close', closeSlidePromptModal);
  bindClick('btn-copy-prompt', copyPrompt);
  on('slide-prompt-modal', 'click', ({ target }) => {
    if (target.id === 'slide-prompt-modal') closeSlidePromptModal();
  });

  bindClick('btn-add-color', showAddColorForm);
  bindClick('btn-save-color', saveCustomColor);
  bindClick('btn-cancel-color', hideAddColorForm);

  bindClick('btn-save-preset', showSavePresetForm);
  bindClick('btn-confirm-save-preset', savePreset);
  bindClick('btn-cancel-save-preset', hideSavePresetForm);

  for (const id of ['main-color', 'accent-color', 'bg-color']) {
    const select = byId(id);
    const customInput = byId(`${id}-custom`);
    const sync = () => {
      const customMode = select.value === 'custom';
      customInput.classList.toggle('hidden', !customMode);
      if (customMode) customInput.focus();
      updateColorPreview(id);
      generatePrompt();
    };
    select.addEventListener('change', sync);
    customInput.addEventListener('input', sync);
  }

  for (const id of ['jp-font', 'en-font']) {
    on(id, 'change', generatePrompt);
  }

  on('slide-tone', 'change', () => {
    applyTonePreset();
    generatePrompt();
  });

  const handleThemeChange = () => loadAndApplyTheme();
  if (typeof systemThemeQuery.addEventListener === 'function') {
    systemThemeQuery.addEventListener('change', handleThemeChange);
  } else if (typeof systemThemeQuery.addListener === 'function') {
    systemThemeQuery.addListener(handleThemeChange);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    loadAndApplyTheme();
  });
});


async function loadStats() {
  const organizerState = await getState();
  const {
    notebooks = [],
    groups = [],
    favorites = [],
    assignments = {}
  } = organizerState;

  const notebookIdSet = new Set(notebooks.map(({ id }) => id));
  const counters = {
    notebooks: notebooks.length || '-',
    groups: groups.length || '0',
    favorites: favorites.filter((id) => notebookIdSet.has(id)).length || '0',
    assigned: Object.keys(assignments).filter((id) => notebookIdSet.has(id)).length || '0'
  };

  document.getElementById('stat-notebooks').textContent = counters.notebooks;
  document.getElementById('stat-groups').textContent = counters.groups;
  document.getElementById('stat-favorites').textContent = counters.favorites;
  document.getElementById('stat-assigned').textContent = counters.assigned;
}


async function refreshStats() {
  const btn = document.getElementById('btn-refresh-stats');
  btn.classList.add('loading');
  
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    await cleanupOrphanedData();
    await loadStats();
    showMessage('Stats updated', 'success');
  } catch (error) {
    console.error('Refresh error:', error);
    showMessage('Update failed', 'error');
  } finally {
    btn.classList.remove('loading');
  }
}




async function cleanupOrphanedData() {
  const tabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
  if (!tabs.length) {
    console.log('No NotebookLM tab found, skipping cleanup to prevent accidental data loss');
    return;
  }

  let latestNotebookIds;
  for (const tab of tabs) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getNotebookIds' });
      if (response && response.success && response.notebookIds) {
        latestNotebookIds = new Set(response.notebookIds);
        break;
      }
    } catch (error) {
      console.log('Tab did not respond:', error);
    }
  }
  if (!latestNotebookIds || latestNotebookIds.size === 0) {
    console.log('Could not get latest notebook IDs, skipping cleanup');
    return;
  }

  const organizerState = await getState();
  const favorites = organizerState.favorites || [];
  const assignments = organizerState.assignments || {};

  const cleanedFavorites = favorites.filter((id) => latestNotebookIds.has(id));
  const cleanedAssignments = Object.fromEntries(
    Object.entries(assignments).filter(([id]) => latestNotebookIds.has(id))
  );

  const favoritesChanged = cleanedFavorites.length !== favorites.length;
  const assignmentsChanged = Object.keys(cleanedAssignments).length !== Object.keys(assignments).length;
  if (favoritesChanged || assignmentsChanged) {
    await setState({
      ...organizerState,
      favorites: cleanedFavorites,
      assignments: cleanedAssignments
    });
    console.log('Cleaned up orphaned data:', {
      favoritesRemoved: favorites.length - cleanedFavorites.length,
      assignmentsRemoved: Object.keys(assignments).length - Object.keys(cleanedAssignments).length
    });
  }
}


async function exportData() {
  try {
    const organizerState = await getState();
    const backupPayload = {
      version: '1.1.0',
      schema: 'folderlm-workspace',
      exportedAt: new Date().toISOString(),
      groups: organizerState.groups || [],
      favorites: organizerState.favorites || [],
      assignments: organizerState.assignments || {},
      expandedGroups: organizerState.expandedGroups || {}
    };
    const objectUrl = URL.createObjectURL(
      new Blob([JSON.stringify(backupPayload, null, 2)], { type: 'application/json' })
    );
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `folderlm-workspace-backup-${formatDate(new Date())}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);

    showMessage('Data exported', 'success');
  } catch {
    showMessage('Export failed', 'error');
  }
}


function normalizeTitle(title) {
  return title
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
    .replace(/[\u{2300}-\u{23FF}]/gu, '')
    .replace(/[\u{2B50}]/gu, '')
    .replace(/[\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}


async function importData(event) {
  const input = event.target;
  const [file] = input.files || [];
  if (!file) return;
  try {
    const text = await file.text();
    const importedData = JSON.parse(text);
    if (!importedData.version || !Array.isArray(importedData.groups)) {
      throw new Error('Invalid backup file format');
    }
    const importSummary = [
      `- Groups: ${importedData.groups.length}`,
      `- Favorites: ${importedData.favorites?.length || 0}`,
      `- Assignments: ${Object.keys(importedData.assignments || {}).length}`
    ].join('\n');
    const confirmMessage =
      `Importing will overwrite your current data.\n\nImport contents:\n${importSummary}\n\nContinue?`;
    if (!confirm(confirmMessage)) {
      input.value = '';
      return;
    }
    const currentState = await getState();
    const newState = {
      ...currentState,
      groups: importedData.groups,
      favorites: importedData.favorites || [],
      assignments: importedData.assignments || {},
      expandedGroups: importedData.expandedGroups || {},
      missingIdCounts: {},
      importedAt: Date.now()
    };
    await setState(newState);
    try {
      const tabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { action: 'reloadState' });
      }
    } catch {}
    showMessage('Data imported', 'success');
    loadStats();
  } catch {
    showMessage('Import failed. Please check the file format.', 'error');
  } finally {
    input.value = '';
  }
}


async function openSidePanel() {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isNotebookLm = Boolean(activeTab?.url?.includes('notebooklm.google.com'));
    const targetTab = isNotebookLm
      ? activeTab
      : await chrome.tabs.create({ url: 'https://notebooklm.google.com/' });

    if (!isNotebookLm) {
      setTimeout(async () => {
        try {
          await chrome.sidePanel.open({ tabId: targetTab.id });
        } catch {
          console.log('Side panel will open when page loads');
        }
      }, 1000);
    } else {
      await chrome.sidePanel.open({ tabId: targetTab.id });
    }
    window.close();
  } catch (error) {
    console.error('Error opening side panel:', error);
    alert('Could not open the side panel. Please try on a NotebookLM page.');
  }
}


function openNotebookLM() {
  chrome.tabs.create({ url: 'https://notebooklm.google.com/' });
}


async function resetData() {
  const confirmMessage = [
    'Are you sure you want to delete all data?',
    '',
    '- All groups',
    '- All favorites',
    '- All assignments',
    '',
    'This action cannot be undone.'
  ].join('\n');

  if (!confirm(confirmMessage)) return;
  if (!confirm('Final confirmation: delete everything?')) return;

  try {
    await clearState();
    const tabs = await chrome.tabs.query({ url: 'https://notebooklm.google.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'resetState' });
      } catch {}
    }
    showMessage('All data deleted. Please reload the NotebookLM page.', 'success');
    loadStats();
  } catch (error) {
    console.error('Reset error:', error);
    showMessage('Reset failed', 'error');
  }
}


function showMessage(text, type = 'info') {
  const messageEl = document.getElementById('message');
  messageEl.textContent = text;
  messageEl.className = `message ${type}`;
  messageEl.classList.remove('hidden');

  setTimeout(() => {
    messageEl.classList.add('hidden');
  }, 5000);
}


function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// ========================================

// ========================================

function openSlidePromptModal() {
  document.getElementById('slide-prompt-modal').classList.remove('hidden');
  initializePromptBuilder();
}

function closeSlidePromptModal() {
  document.getElementById('slide-prompt-modal').classList.add('hidden');
}

function initializePromptBuilder() {
  void loadCustomColors();
  void loadPresets();
  applyTonePreset();
  refreshAllColorPreviews();
  generatePrompt();
}

function getColorValue(id) {
  const selectElement = document.getElementById(id);
  const customInput = document.getElementById(`${id}-custom`);
  const isCustom = selectElement.value === 'custom';
  return isCustom ? (customInput.value || '#000000') : selectElement.value;
}

function updateColorPreview(id) {
  const previewElement = document.getElementById(`${id}-preview`);
  if (!previewElement) return;
  previewElement.style.backgroundColor = getColorValue(id);
}

function refreshAllColorPreviews() {
  ['main-color', 'accent-color', 'bg-color'].forEach(updateColorPreview);
}

const TONE_PRESETS = {
  simple: {
    mainColor: '#1d1d1f',
    accentColor: '#0071e3',
    bgColor: '#ffffff',
    jpFont: 'Hiragino Sans',
    enFont: 'Helvetica Neue',
    description: 'Minimal layout with generous whitespace'
  },
  business: {
    mainColor: '#323130',
    accentColor: '#0078d4',
    bgColor: '#ffffff',
    jpFont: 'Yu Gothic',
    enFont: 'Segoe UI',
    description: 'Professional layout focused on clarity and trust'
  },
  modern: {
    mainColor: '#202124',
    accentColor: '#1a73e8',
    bgColor: '#ffffff',
    jpFont: 'Noto Sans JP',
    enFont: 'Roboto',
    description: 'Clean modern baseline style'
  },
  pop: {
    mainColor: '#1d1c1d',
    accentColor: '#36c5f0',
    bgColor: '#ffffff',
    jpFont: 'Noto Sans JP',
    enFont: 'Poppins',
    description: 'Bright and approachable casual layout'
  },
  elegant: {
    mainColor: '#2c2c2c',
    accentColor: '#b8860b',
    bgColor: '#fffef5',
    jpFont: 'Yu Mincho',
    enFont: 'Cormorant Garamond',
    description: 'Luxury & classic - elegant, refined design'
  },
  tech: {
    mainColor: '#161616',
    accentColor: '#0f62fe',
    bgColor: '#f4f4f4',
    jpFont: 'IBM Plex Sans JP',
    enFont: 'IBM Plex Sans',
    description: 'Technical layout with structured visual rhythm'
  },
  natural: {
    mainColor: '#3d5a45',
    accentColor: '#a8c686',
    bgColor: '#fafaf5',
    jpFont: 'Noto Serif JP',
    enFont: 'Source Serif Pro',
    description: 'Natural & organic - warm, gentle design'
  },
  dynamic: {
    mainColor: '#2c2c2c',
    accentColor: '#fa0f00',
    bgColor: '#ffffff',
    jpFont: 'Source Han Sans JP',
    enFont: 'Source Sans Pro',
    description: 'Bold layout with strong visual impact'
  },
  creative: {
    mainColor: '#611f69',
    accentColor: '#e01e5a',
    bgColor: '#ffffff',
    jpFont: 'Noto Sans JP',
    enFont: 'Lato',
    description: 'Playful layout with high visual energy'
  },
  academic: {
    mainColor: '#1e3a5f',
    accentColor: '#8b4513',
    bgColor: '#fffef8',
    jpFont: 'Yu Mincho',
    enFont: 'EB Garamond',
    description: 'Academic & authoritative - formal, credible design'
  }
};

const TONE_GUIDE_LINES = {
  simple: 'Simple & minimal: prioritize whitespace, low visual noise, and one key point per slide.',
  business: 'Business & professional: favor structured hierarchy, data clarity, and decision-ready framing.',
  modern: 'Modern & stylish: use clean spacing and contemporary visual rhythm for a polished look.',
  pop: 'Pop & casual: combine energetic colors, playful composition, and icon-led emphasis.',
  elegant: 'Elegant & premium: pursue refined typography, restrained accents, and generous breathing room.',
  tech: 'Tech & futuristic: communicate precision and innovation with a sharp, digital aesthetic.',
  natural: 'Natural & soft: apply warm tones and gentle curves to keep the deck approachable.',
  dynamic: 'Dynamic & impactful: increase contrast and directional flow to guide viewer attention.',
  creative: 'Creative & unique: use unconventional arrangements while keeping readability intact.',
  academic: 'Academic & formal: keep the tone rigorous, readable, and evidence-oriented.'
};

const TONE_LABELS = {
  simple: 'Simple',
  business: 'Business',
  modern: 'Modern',
  pop: 'Pop',
  elegant: 'Elegant',
  tech: 'Tech',
  natural: 'Natural',
  dynamic: 'Dynamic',
  creative: 'Creative',
  academic: 'Academic'
};

function generatePrompt() {
  const colors = {
    primary: getColorValue('main-color'),
    accent: getColorValue('accent-color'),
    background: getColorValue('bg-color')
  };
  const jpFont = document.getElementById('jp-font').value.split(',')[0];
  const enFont = document.getElementById('en-font').value.split(',')[0];
  const tone = document.getElementById('slide-tone').value;

  const promptSections = [
    'Please create slides with the following design specs.',
    '',
    '[Tone / Mood]',
    TONE_GUIDE_LINES[tone] || TONE_GUIDE_LINES.simple,
    '',
    '[Color Settings]',
    `- Primary color: ${colors.primary}`,
    `- Accent color: ${colors.accent}`,
    `- Background color: ${colors.background}`,
    '',
    '[Font Settings]',
    `- Japanese: ${jpFont}`,
    `- English: ${enFont}`,
    '',
    '[Other]',
    '- Ensure strong readability and contrast',
    '- Keep the design cohesive'
  ];
  document.getElementById('generated-prompt').value = promptSections.join('\n');
}

function applyTonePreset() {
  const tone = document.getElementById('slide-tone').value;
  const preset = TONE_PRESETS[tone];
  if (!preset) return;

  document.getElementById('tone-description').textContent = preset.description;
  [
    ['main-color', preset.mainColor],
    ['accent-color', preset.accentColor],
    ['bg-color', preset.bgColor],
    ['jp-font', preset.jpFont],
    ['en-font', preset.enFont]
  ].forEach(([fieldId, value]) => setSelectValue(fieldId, value));

  refreshAllColorPreviews();
}

function setSelectValue(selectId, value) {
  const select = document.getElementById(selectId);
  const customInput = document.getElementById(`${selectId}-custom`);

  const exactOption = Array.from(select.options).find((option) => option.value === value);
  if (exactOption) {
    select.value = exactOption.value;
    if (customInput) customInput.classList.add('hidden');
    return;
  }

  if (customInput) {
    select.value = 'custom';
    customInput.value = value;
    customInput.classList.remove('hidden');
  }
}

async function copyPrompt() {
  const prompt = document.getElementById('generated-prompt').value;
  const btn = document.getElementById('btn-copy-prompt');
  
  try {
    await navigator.clipboard.writeText(prompt);
    btn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
      </svg>
      Copied
    `;
    btn.classList.add('copied');
    
    setTimeout(() => {
      btn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        Copy
      `;
      btn.classList.remove('copied');
    }, 2000);
  } catch (err) {
    console.error('Copy failed:', err);
  }
}

async function readListFromStorage(key) {
  try {
    const data = await chrome.storage.local.get([key]);
    return Array.isArray(data[key]) ? data[key] : [];
  } catch {
    return [];
  }
}

async function writeListToStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

function createEmptyLabel(className, text) {
  const label = document.createElement('span');
  label.className = className;
  label.textContent = text;
  return label;
}

async function loadCustomColors() {
  const colors = await readListFromStorage('customColors');
  renderCustomColorsList(colors);
  updateColorSelectOptions(colors);
}

function renderCustomColorsList(colors) {
  const list = document.getElementById('custom-colors-list');
  list.innerHTML = '';

  if (!colors.length) {
    list.appendChild(createEmptyLabel('empty-colors', 'No saved colors'));
    return;
  }

  const fragment = document.createDocumentFragment();
  colors.forEach((color, index) => {
    const item = document.createElement('div');
    item.className = 'custom-color-item';

    const dot = document.createElement('div');
    dot.className = 'color-dot';
    dot.style.background = color.code;

    const name = document.createElement('span');
    name.className = 'color-name';
    name.title = `${color.name} (${color.code})`;
    name.textContent = color.name;

    const removeButton = document.createElement('button');
    removeButton.className = 'delete-color';
    removeButton.title = 'Delete';
    removeButton.innerHTML = '&times;';
    removeButton.addEventListener('click', () => {
      void deleteCustomColor(index);
    });

    item.append(dot, name, removeButton);
    fragment.appendChild(item);
  });

  list.appendChild(fragment);
}

function updateColorSelectOptions(colors) {
  const targets = ['main-color', 'accent-color', 'bg-color'];
  targets.forEach((selectId) => {
    const select = document.getElementById(selectId);
    select.querySelectorAll('option[data-custom="true"]').forEach((option) => option.remove());

    const insertionPoint = select.querySelector('option[value="custom"]');
    const fragment = document.createDocumentFragment();
    colors.forEach((color) => {
      const option = document.createElement('option');
      option.value = color.code;
      option.textContent = `${color.name} (${color.code})`;
      option.dataset.custom = 'true';
      fragment.appendChild(option);
    });
    select.insertBefore(fragment, insertionPoint);
  });
}

function showAddColorForm() {
  document.getElementById('add-color-form').classList.remove('hidden');
  document.getElementById('new-color-name').focus();
}

function hideAddColorForm() {
  document.getElementById('add-color-form').classList.add('hidden');
  document.getElementById('new-color-name').value = '';
  document.getElementById('new-color-code').value = '';
}

async function saveCustomColor() {
  const name = document.getElementById('new-color-name').value.trim();
  const rawCode = document.getElementById('new-color-code').value.trim();
  if (!name) {
    alert('Please enter a color name');
    return;
  }
  if (!rawCode) {
    alert('Please enter a color code');
    return;
  }

  const normalizedCode = rawCode.startsWith('#') ? rawCode.toLowerCase() : `#${rawCode.toLowerCase()}`;
  if (!/^#[0-9A-Fa-f]{6}$/.test(normalizedCode)) {
    alert('Color code must be in #RRGGBB format (e.g., #1a73e8)');
    return;
  }

  try {
    const colors = await readListFromStorage('customColors');
    if (colors.some((color) => color.code.toLowerCase() === normalizedCode)) {
      alert('This color code is already saved');
      return;
    }

    const nextColors = [...colors, { name, code: normalizedCode }];
    await writeListToStorage('customColors', nextColors);

    hideAddColorForm();
    await loadCustomColors();
  } catch (e) {
    console.error('Error saving custom color:', e);
    alert('Save failed');
  }
}

async function deleteCustomColor(index) {
  if (!confirm('Delete this color?')) return;

  try {
    const colors = await readListFromStorage('customColors');
    const nextColors = colors.filter((_, colorIndex) => colorIndex !== index);
    await writeListToStorage('customColors', nextColors);
    await loadCustomColors();
  } catch (e) {
    console.error('Error deleting custom color:', e);
    alert('Delete failed');
  }
}

async function loadPresets() {
  const presets = await readListFromStorage('slidePresets');
  renderPresetList(presets);
}

function renderPresetList(presets) {
  const list = document.getElementById('preset-list');
  list.innerHTML = '';

  if (!presets.length) {
    list.appendChild(createEmptyLabel('empty-presets', 'No saved presets'));
    return;
  }

  const fragment = document.createDocumentFragment();
  presets.forEach((preset, index) => {
    const row = document.createElement('div');
    row.className = 'preset-item';
    row.dataset.index = String(index);

    const name = document.createElement('span');
    name.className = 'preset-name';
    name.textContent = preset.name;

    const tone = document.createElement('span');
    tone.className = 'preset-tone';
    tone.textContent = getToneName(preset.tone);

    const removeButton = document.createElement('button');
    removeButton.className = 'delete-preset';
    removeButton.title = 'Delete';
    removeButton.innerHTML = '&times;';
    removeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      void deletePreset(index);
    });

    row.addEventListener('click', () => {
      void loadPreset(index);
    });

    row.append(name, tone, removeButton);
    fragment.appendChild(row);
  });

  list.appendChild(fragment);
}

function getToneName(toneValue) {
  return TONE_LABELS[toneValue] || toneValue;
}

function showSavePresetForm() {
  document.getElementById('save-preset-form').classList.remove('hidden');
  document.getElementById('new-preset-name').focus();
}

function hideSavePresetForm() {
  document.getElementById('save-preset-form').classList.add('hidden');
  document.getElementById('new-preset-name').value = '';
}

async function savePreset() {
  const name = document.getElementById('new-preset-name').value.trim();
  if (!name) {
    alert('Please enter a preset name');
    return;
  }

  const preset = {
    name,
    tone: document.getElementById('slide-tone').value,
    mainColor: getColorValue('main-color'),
    accentColor: getColorValue('accent-color'),
    bgColor: getColorValue('bg-color'),
    jpFont: document.getElementById('jp-font').value,
    enFont: document.getElementById('en-font').value,
    prompt: document.getElementById('generated-prompt').value,
    createdAt: new Date().toISOString()
  };

  try {
    const presets = await readListFromStorage('slidePresets');
    const nextPresets = [preset, ...presets].slice(0, 20);
    await writeListToStorage('slidePresets', nextPresets);

    hideSavePresetForm();
    await loadPresets();
  } catch (e) {
    console.error('Error saving preset:', e);
    alert('Save failed');
  }
}

async function loadPreset(index) {
  try {
    const presets = await readListFromStorage('slidePresets');
    const preset = presets[index];
    if (!preset) return;

    document.getElementById('slide-tone').value = preset.tone;
    [
      ['main-color', preset.mainColor],
      ['accent-color', preset.accentColor],
      ['bg-color', preset.bgColor],
      ['jp-font', preset.jpFont],
      ['en-font', preset.enFont]
    ].forEach(([fieldId, value]) => setSelectValue(fieldId, value));

    refreshAllColorPreviews();
    const tonePreset = TONE_PRESETS[preset.tone];
    if (tonePreset) document.getElementById('tone-description').textContent = tonePreset.description;
    document.getElementById('generated-prompt').value = preset.prompt;
  } catch (e) {
    console.error('Error loading preset:', e);
    alert('Load failed');
  }
}

async function deletePreset(index) {
  if (!confirm('Delete this preset?')) return;

  try {
    const presets = await readListFromStorage('slidePresets');
    const nextPresets = presets.filter((_, presetIndex) => presetIndex !== index);
    await writeListToStorage('slidePresets', nextPresets);
    await loadPresets();
  } catch (e) {
    console.error('Error deleting preset:', e);
    alert('Delete failed');
  }
}

// ========================================

// ========================================

async function loadAndApplyTheme() {
  try {
    const effectiveTheme = systemThemeQuery.matches ? 'dark' : 'light';
    document.body.classList.toggle('light-theme', effectiveTheme === 'light');
  } catch (e) {
    console.error('Error loading theme:', e);
  }
}
