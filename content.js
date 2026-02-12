// ========================================
// FolderLM - Content Script
// ========================================

(function() {
  'use strict';


  const DEBUG = false;
  function log(...args) {
    if (DEBUG) console.log('[FolderLM]', ...args);
  }


  function isExtensionContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  const STORAGE_KEY = 'folderlmWorkspaceState';

  function getStateFromStorage() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
          if (chrome.runtime.lastError) {
            log('Storage error:', chrome.runtime.lastError);
            resolve(null);
            return;
          }
          resolve(result[STORAGE_KEY] || null);
        });
      } catch (e) {
        log('Error loading state:', e);
        resolve(null);
      }
    });
  }


  const state = {
    notebooks: [],
    previousNotebooks: [],
    groups: [],
    favorites: [],
    assignments: {}, // notebookId -> groupId
    expandedGroups: {},
    sidebarWidth: 248,
    searchQuery: '',
    mainFilterGroupId: 'all',
    viewMode: 'custom', // folder-only mode
    theme: 'auto', // 'auto' | 'dark' | 'light'
    initialized: false,
    sidebarHovered: false,
    pendingUpdate: false,
    missingIdCounts: {},
    activeNotebookId: null
  };


  const SIDEBAR_MIN_WIDTH = 200;
  const SIDEBAR_MAX_WIDTH_RATIO = 0.4;
  const SIDEBAR_MAX_WIDTH_ABSOLUTE = 500;


  const CLEANUP_THRESHOLD = 3;
  const DETECTION_DROP_THRESHOLD = 0.5;


  let isSavingFromContentScript = false;


  let domObserver = null;
  let urlObserver = null;
  const compactContainers = new Set();
  let dragGhostMoveHandler = null;


  const COLORS = [
    // Mondrian accents (keep)
    '#D62828', '#F4D35E', '#21468B',
    // NYU purple
    '#57068C',
    // Additional variants to fill two rows
    '#E35D5B', '#F6DD8C', '#4B67B2', '#7447A8',
    '#B53B39', '#E8BE42', '#1B3F8F', '#3F0C78',
    // Low-saturation, non-crayon companions
    '#6A8FB3', '#5F9D94', '#6EA183',
    '#8A9B6E', '#B07A5A', '#A56B6B',
    '#9A6C86', '#8A78A8', '#6F7FA8', '#5E6B83',
    '#4F6A6A'
  ];

  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

  // ========================================

  // ========================================

  async function loadState() {
    const hydrateFromSavedState = (savedState) => {
      if (!savedState) return;

      Object.assign(state, {
        groups: savedState.groups || [],
        favorites: [],
        assignments: savedState.assignments || {},
        expandedGroups: savedState.expandedGroups || {},
        sidebarWidth: savedState.sidebarWidth || 248,
        viewMode: 'custom',
        theme: 'auto',
        mainFilterGroupId: savedState.mainFilterGroupId || 'all',
        previousNotebooks: savedState.notebooks || [],
        importedAt: savedState.importedAt || null,
        missingIdCounts: savedState.missingIdCounts || {}
      });
      normalizeGroupHierarchy();
    };

    return new Promise((resolve) => {
      if (!isExtensionContextValid()) {
        log('Extension context invalidated, skipping loadState');
        resolve();
        return;
      }
      try {
        getStateFromStorage().then((savedState) => {
          hydrateFromSavedState(savedState);
          log('State loaded:', state);
          resolve();
        });
      } catch (e) {
        log('Error loading state:', e);
        resolve();
      }
    });
  }

  async function saveState() {
    if (!isExtensionContextValid()) {
      log('Extension context invalidated, skipping saveState');
      return;
    }
    const dataToSave = {
      groups: state.groups,
      favorites: state.favorites,
      assignments: state.assignments,
      expandedGroups: state.expandedGroups,
      sidebarWidth: state.sidebarWidth,
      viewMode: state.viewMode,
      theme: state.theme,
      mainFilterGroupId: state.mainFilterGroupId,

      notebooks: state.notebooks || [],

      importedAt: state.importedAt || null,

      missingIdCounts: state.missingIdCounts || {}
    };
    return new Promise((resolve) => {
      try {
        isSavingFromContentScript = true;
        chrome.storage.local.set({ [STORAGE_KEY]: dataToSave }, () => {
          isSavingFromContentScript = false;
          if (chrome.runtime.lastError) {
            log('Storage error:', chrome.runtime.lastError);
          }
          resolve();
        });
      } catch (e) {
        isSavingFromContentScript = false;
        log('Error saving state:', e);
        resolve();
      }
    });
  }

  // ========================================

  // ========================================


  function generateHashId(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return 'nb-' + Math.abs(hash).toString(36);
  }

  function resolveNotebookElement(el) {
    if (!el) return null;
    return el.closest(
      'project-button, tr.mat-mdc-row:not(.mat-mdc-header-row), [role="listitem"], li, .project-card, [class*="notebook-card"], [class*="project-item"], mat-card'
    ) || el;
  }

  function detectNotebooks() {

    const isNotebookPage = window.location.pathname.includes('/notebook/');
    if (isNotebookPage) {
      log('On notebook detail page, skipping detection to protect data');
      return state.notebooks;
    }
    
    const notebooks = [];
    log('Detecting notebooks...');

    function getSectionMarkers() {
      const featuredKeywords = [
        'featured notebook',
        'featured notebooks',
        'notebooks em destaque',
        'notebooks destacados'
      ];
      const myKeywords = [
        'my notebook',
        'my notebooks',
        'meus notebooks',
        'mis notebooks'
      ];
      const recentKeywords = [
        'recent notebook',
        'recent notebooks',
        'notebooks recentes',
        'notebooks recientes'
      ];

      const mainRoot = document.querySelector('main, [role="main"]') || document.body;
      const headingSelectors = ['h1', 'h2', 'h3', '[role="heading"]'];
      const headings = Array.from(mainRoot.querySelectorAll(headingSelectors.join(',')));

      return headings
        .map((el) => {
          const text = (el.textContent || '').trim().toLowerCase();
          if (!text) return null;
          const y = el.getBoundingClientRect().top + window.scrollY;
          let type = null;
          if (featuredKeywords.some((k) => text.includes(k))) type = 'featured';
          else if (myKeywords.some((k) => text.includes(k))) type = 'my';
          else if (recentKeywords.some((k) => text.includes(k))) type = 'recent';
          if (!type) return null;
          return { y, type };
        })
        .filter(Boolean)
        .sort((a, b) => a.y - b.y);
    }

    const sectionMarkers = getSectionMarkers();

    function isFeaturedElement(el) {
      if (!el || sectionMarkers.length === 0) return false;
      const rect = el.getBoundingClientRect();
      const y = rect.top + window.scrollY + rect.height / 2;

      let marker = null;
      for (let i = 0; i < sectionMarkers.length; i += 1) {
        if (sectionMarkers[i].y <= y) marker = sectionMarkers[i];
        else break;
      }
      return marker?.type === 'featured';
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
    

    const existingTitleToId = {};
    

    if (state.previousNotebooks && state.previousNotebooks.length > 0) {
      state.previousNotebooks.forEach(nb => {
        const normalizedTitle = normalizeTitle(nb.title);
        existingTitleToId[normalizedTitle] = nb.id;
        existingTitleToId[nb.title] = nb.id;
      });
    }
    

    if (state.notebooks && state.notebooks.length > 0) {
      state.notebooks.forEach(nb => {
        const normalizedTitle = normalizeTitle(nb.title);
        if (!existingTitleToId[normalizedTitle]) {
          existingTitleToId[normalizedTitle] = nb.id;
        }
        if (!existingTitleToId[nb.title]) {
          existingTitleToId[nb.title] = nb.id;
        }
      });
    }
    
    log('Existing title-to-ID mappings:', Object.keys(existingTitleToId).length);
    

    const tableRows = document.querySelectorAll('tr.mat-mdc-row:not(.mat-mdc-header-row)');
    const allCards = document.querySelectorAll('.mdc-card, .project-card, [class*="notebook-card"], mat-card');
    


    log('Found mat-mdc-row rows:', tableRows.length);
    
    if (tableRows.length > 0) {
      tableRows.forEach((row, index) => {

        const titleEl = row.querySelector('.project-table-title');
        let title = '';
        if (titleEl) {

          title = titleEl.textContent.trim();
        } else {

          const firstCell = row.querySelector('td');
          if (firstCell) {
            title = firstCell.textContent.trim();
          }
        }
        
        if (!title) {
          log('Skipping row without title:', index);
          return;
        }
        

        const excludeKeywords = ['Create new', 'New notebook', 'Create new notebook'];
        const shouldExclude = excludeKeywords.some(keyword => 
          title.includes(keyword) || title.toLowerCase().includes(keyword.toLowerCase())
        );
        if (shouldExclude) {
          log('Skipping action button:', title);
          return;
        }
        

        let date = new Date();
        const rowText = row.textContent;
        const dateMatch = rowText.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
        if (dateMatch) {
          date = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
        }
        

        const normalizedTitle = normalizeTitle(title);
        const id = existingTitleToId[normalizedTitle] || existingTitleToId[title] || generateHashId(normalizedTitle);
        
        const rootEl = resolveNotebookElement(row);
        if (rootEl) rootEl.setAttribute('data-flm-id', id);
        
        notebooks.push({
          id,
          title,
          date,
          element: rootEl || row,
          manageable: !isFeaturedElement(rootEl || row)
        });
      });
    }
    

    if (notebooks.length === 0) {
      log('Trying card/tile detection...');
      

      const cardSelectors = [
        '.mdc-card',
        '.project-card',
        '[class*="notebook-card"]',
        '[class*="project-item"]',
        'mat-card'
      ];
      
      let cards = [];
      for (const selector of cardSelectors) {
        cards = document.querySelectorAll(selector);
        if (cards.length > 0) {
          log('Found cards with selector:', selector, cards.length);
          break;
        }
      }
      

      if (cards.length === 0) {

        const clickableRows = document.querySelectorAll('[jslog*="track:generic_click"]');
        log('Found clickable elements with jslog:', clickableRows.length);
        
        clickableRows.forEach((el, index) => {
          const titleEl = el.querySelector('.project-table-title, [class*="title"]');
          let title = titleEl ? titleEl.textContent.trim() : el.textContent.trim().slice(0, 50);
          
          if (!title || title.includes('Title')) return; // Skip header rows
          

          const excludeKeywords = ['Create new', 'New notebook', 'Create new notebook'];
          const shouldExclude = excludeKeywords.some(keyword => 
            title.includes(keyword) || title.toLowerCase().includes(keyword.toLowerCase())
          );
          if (shouldExclude) return;
          
          let date = new Date();
          const dateMatch = el.textContent.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
          if (dateMatch) {
            date = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
          }
          

          const normalizedTitle = normalizeTitle(title);
          const id = existingTitleToId[normalizedTitle] || existingTitleToId[title] || generateHashId(normalizedTitle);
          const rootEl = resolveNotebookElement(el);
          if (rootEl) rootEl.setAttribute('data-flm-id', id);
          
          notebooks.push({
            id,
            title,
            date,
            element: rootEl || el,
            manageable: !isFeaturedElement(rootEl || el)
          });
        });
      }
      
      cards.forEach((card, index) => {

        let titleEl = card.querySelector('.project-title, [class*="project-title"], [class*="title"]:not([class*="subtitle"])');
        if (!titleEl) {
          titleEl = card.querySelector('h2, h3, h4');
        }
        let title = titleEl ? titleEl.textContent.trim() : '';
        

        if (!title) {
          const textContent = card.textContent.trim();

          const lines = textContent.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^\d{4}\/\d{1,2}\/\d{1,2}/));
          title = lines[0] || `Notebook ${index + 1}`;
        }
        

        const excludeKeywords = ['Create new', 'New notebook', 'Create new notebook'];
        const shouldExclude = excludeKeywords.some(keyword => 
          title.includes(keyword) || title.toLowerCase().includes(keyword.toLowerCase())
        );
        if (shouldExclude) return;
        
        let date = new Date();
        const dateMatch = card.textContent.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
        if (dateMatch) {
          date = new Date(parseInt(dateMatch[1]), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[3]));
        }
        

        const normalizedTitle = normalizeTitle(title);
        const id = existingTitleToId[normalizedTitle] || existingTitleToId[title] || generateHashId(normalizedTitle);
        
        const rootEl = resolveNotebookElement(card);
        if (rootEl) rootEl.setAttribute('data-flm-id', id);
        
        notebooks.push({
          id,
          title,
          date,
          element: rootEl || card,
          manageable: !isFeaturedElement(rootEl || card)
        });
      });
    }

    log('Detected notebooks:', notebooks.length, notebooks.map(n => n.title));
    

    log('Title-ID pairs (first 5):', notebooks.slice(0, 5).map(n => ({ title: n.title, id: n.id })));
    

    if (notebooks.length === 0 && state.notebooks.length > 0) {
      log('No notebooks found, keeping existing data:', state.notebooks.length);
      return state.notebooks;
    }
    

    const prevCount = state.notebooks.length;
    const skipCleanup = prevCount > 0 && notebooks.length < prevCount * DETECTION_DROP_THRESHOLD;
    if (skipCleanup) {
      log('Detection count dropped significantly, skipping cleanup:', prevCount, '->', notebooks.length);
    }
    

    const isHomePage = window.location.pathname === '/';
    if (isHomePage) {
      migrateNotebookIds(notebooks);
    }
    
    const detectedManageableCount = notebooks.filter(nb => nb.manageable !== false).length;
    if (detectedManageableCount === 0 && state.notebooks.some(nb => nb.manageable !== false)) {
      const keep = state.notebooks.filter(nb => nb.manageable !== false);
      const merged = [...keep, ...notebooks];
      const byId = new Map();
      merged.forEach((nb) => {
        const prev = byId.get(nb.id);
        if (!prev) {
          byId.set(nb.id, nb);
          return;
        }
        if (!prev.element && nb.element) {
          byId.set(nb.id, nb);
        }
      });
      state.notebooks = Array.from(byId.values());
    } else {
      state.notebooks = notebooks;
    }
    

    const importGracePeriod = 300000;
    const isRecentImport = state.importedAt && (Date.now() - state.importedAt) < importGracePeriod;
    if (isRecentImport) {
      log('Recent import detected, skipping cleanup for', Math.round((importGracePeriod - (Date.now() - state.importedAt)) / 1000), 'more seconds');

      if ((Date.now() - state.importedAt) > importGracePeriod) {
        delete state.importedAt;
      }
    }
    

    const notebookIds = new Set(notebooks.map(nb => nb.id));
    

    const trackedIds = new Set([
      ...Object.keys(state.assignments)
    ]);
    

    let cleanupPerformed = false;
    trackedIds.forEach(id => {
      if (notebookIds.has(id)) {

        if (state.missingIdCounts[id]) {
          log('ID found again, resetting counter:', id);
          delete state.missingIdCounts[id];
        }
      } else if (!skipCleanup && !isRecentImport) {

        state.missingIdCounts[id] = (state.missingIdCounts[id] || 0) + 1;
        log('ID not found, counter:', id, state.missingIdCounts[id]);
        

        if (state.missingIdCounts[id] >= CLEANUP_THRESHOLD) {
          log('Cleanup threshold reached, removing:', id);
          

          if (state.assignments[id]) {
            delete state.assignments[id];
            cleanupPerformed = true;
          }
          

          delete state.missingIdCounts[id];
        }
      }
    });
    
    if (cleanupPerformed) {
      log('Cleanup performed, saving state...');
      saveState();
    }
    


    if (isExtensionContextValid() && isHomePage) {
      try {
        chrome.storage.local.set({
          [STORAGE_KEY]: {
            ...state,
            notebooks: notebooks.map(n => ({ id: n.id, title: n.title, date: n.date.toISOString() }))
          }
        });
      } catch (e) {
        log('Error saving notebooks to storage:', e);
      }
    }
    
    return notebooks;
  }


  function migrateNotebookIds(newNotebooks) {
    const newIds = new Set(newNotebooks.map(n => n.id));
    

    const missingAssignments = Object.keys(state.assignments).filter(id => !newIds.has(id));
    const allMissingIds = [...new Set([...missingAssignments])];
    
    if (allMissingIds.length === 0) return;
    
    log('Missing IDs detected, attempting migration:', allMissingIds);
    

    const oldNotebooks = state.previousNotebooks || [];
    log('Previous notebooks for migration:', oldNotebooks.length);
    
    let migrated = false;
    
    allMissingIds.forEach(oldId => {

      const oldNotebook = oldNotebooks.find(n => n.id === oldId);
      if (!oldNotebook) {
        log('Old notebook not found for ID:', oldId);
        return;
      }
      
      const oldDate = new Date(oldNotebook.date).toDateString();
      log('Looking for candidate with date:', oldDate);
      

      const candidates = newNotebooks.filter(n => {
        const newDate = new Date(n.date).toDateString();
        const isNotAssigned = !state.assignments[n.id];
        const isNewId = !oldNotebooks.some(old => old.id === n.id);
        return newDate === oldDate && isNotAssigned && isNewId;
      });
      
      log('Candidates found:', candidates.length, candidates.map(c => c.title));
      

      if (candidates.length === 1) {
        const candidate = candidates[0];
        log('Migrating ID:', oldId, '->', candidate.id, '(', candidate.title, ')');
        

        if (state.assignments[oldId]) {
          state.assignments[candidate.id] = state.assignments[oldId];
          delete state.assignments[oldId];
          migrated = true;
        }
      } else if (candidates.length > 1) {
        log('Multiple candidates found, cannot auto-migrate for:', oldId);
      }
    });
    

    if (migrated) {
      log('Migration completed, saving state...');
      saveState();
    }
  }

  function parseDate(dateStr) {
    if (!dateStr) return null;
    

    const slashMatch = dateStr.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (slashMatch) {
      return new Date(parseInt(slashMatch[1]), parseInt(slashMatch[2]) - 1, parseInt(slashMatch[3]));
    }
    
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      return date;
    }


    const now = new Date();
    if (dateStr.includes('days ago')) {
      const match = dateStr.match(/(\d+)/);
      if (match) {
        const days = parseInt(match[1]);
        return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      }
    }
    if (dateStr.includes('yesterday')) {
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }
    if (dateStr.includes('today')) {
      return now;
    }

    return null;
  }

  // ========================================

  // ========================================

  function getDateGroupId(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return `date-${year}-${String(month).padStart(2, '0')}`;
  }

  function getDateGroupName(date) {
    const year = date.getFullYear();
    const monthName = date.toLocaleString('en-US', { month: 'long' });
    return `${monthName} ${year}`;
  }

  function getManageableNotebooks() {
    return state.notebooks.filter(nb => nb.manageable !== false);
  }

  function getGroupedNotebooks() {
    const grouped = {
      custom: {}
    };

    const manageable = getManageableNotebooks();
    manageable.forEach(notebook => {
      const isManageable = notebook.manageable !== false;

      const assignedGroup = isManageable ? state.assignments[notebook.id] : null;
      if (assignedGroup) {
        if (!grouped.custom[assignedGroup]) {
          grouped.custom[assignedGroup] = [];
        }
        grouped.custom[assignedGroup].push(notebook);
      }
    });

    return grouped;
  }

  function createGroup(name, color) {
    return createGroupWithParent(name, color, null);
  }

  function normalizeGroupHierarchy() {
    const ids = new Set(state.groups.map((g) => g.id));
    state.groups.forEach((group) => {
      const parentId = group.parentId || null;
      group.parentId = parentId && ids.has(parentId) && parentId !== group.id ? parentId : null;
    });

    const byId = new Map(state.groups.map((g) => [g.id, g]));
    state.groups.forEach((group) => {
      const visited = new Set([group.id]);
      let current = group;
      while (current.parentId) {
        if (visited.has(current.parentId)) {
          group.parentId = null;
          break;
        }
        visited.add(current.parentId);
        const parent = byId.get(current.parentId);
        if (!parent) {
          current.parentId = null;
          break;
        }
        current = parent;
      }
    });
  }

  function getChildGroupIds(parentId) {
    return state.groups
      .filter((g) => (g.parentId || null) === (parentId || null))
      .map((g) => g.id);
  }

  function getGroupDescendantIds(groupId) {
    const ids = new Set();
    const queue = [groupId];
    while (queue.length > 0) {
      const current = queue.shift();
      const children = getChildGroupIds(current);
      children.forEach((childId) => {
        if (ids.has(childId)) return;
        ids.add(childId);
        queue.push(childId);
      });
    }
    return ids;
  }

  function isDescendantGroup(maybeDescendantId, ancestorId) {
    if (!maybeDescendantId || !ancestorId || maybeDescendantId === ancestorId) return false;
    const descendants = getGroupDescendantIds(ancestorId);
    return descendants.has(maybeDescendantId);
  }

  function getOrderedGroupsWithDepth() {
    const ordered = [];
    const visited = new Set();

    function walk(parentId, depth) {
      const children = state.groups.filter((group) => (group.parentId || null) === (parentId || null));
      children.forEach((group) => {
        if (visited.has(group.id)) return;
        visited.add(group.id);
        ordered.push({ group, depth });
        walk(group.id, depth + 1);
      });
    }

    walk(null, 0);
    state.groups
      .filter((g) => !visited.has(g.id))
      .forEach((group) => ordered.push({ group, depth: 0 }));

    return ordered;
  }

  function createGroupWithParent(name, color, parentId = null) {
    const sanitizedParentId = parentId && state.groups.some((g) => g.id === parentId) ? parentId : null;
    const group = {
      id: `group-${Date.now()}`,
      name,
      color: color || COLORS[Math.floor(Math.random() * COLORS.length)],
      parentId: sanitizedParentId,
      createdAt: new Date().toISOString()
    };
    state.groups.push(group);
    normalizeGroupHierarchy();
    saveState();
    refreshMainCategoryBar();
    return group;
  }

  function deleteGroup(groupId) {
    const deletedGroup = state.groups.find((g) => g.id === groupId);
    const fallbackParentId = deletedGroup ? deletedGroup.parentId || null : null;

    state.groups.forEach((group) => {
      if (group.parentId === groupId) {
        group.parentId = fallbackParentId;
      }
    });

    state.groups = state.groups.filter(g => g.id !== groupId);
    if (state.mainFilterGroupId === groupId) {
      state.mainFilterGroupId = 'all';
    }

    Object.keys(state.assignments).forEach(notebookId => {
      if (state.assignments[notebookId] === groupId) {
        delete state.assignments[notebookId];
      }
    });
    normalizeGroupHierarchy();
    saveState();
    refreshMainCategoryBar();
  }

  function renameGroup(groupId, newName) {
    const group = state.groups.find(g => g.id === groupId);
    if (group) {
      group.name = newName;
      saveState();
      refreshMainCategoryBar();
    }
  }

  function updateGroupColor(groupId, color) {
    const group = state.groups.find(g => g.id === groupId);
    if (group) {
      group.color = color;
      saveState();
      updateNotebookCards();
      refreshMainCategoryBar();
    }
  }

  function updateGroupParent(groupId, parentId) {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;
    const validParent = parentId && state.groups.some((g) => g.id === parentId) ? parentId : null;
    if (validParent === groupId) return;
    if (validParent && isDescendantGroup(validParent, groupId)) return;
    group.parentId = validParent;
    normalizeGroupHierarchy();
    saveState();
    refreshMainCategoryBar();
  }

  function assignToGroup(notebookId, groupId) {
    const notebook = state.notebooks.find(nb => nb.id === notebookId);
    if (notebook && notebook.manageable === false) {
      return false;
    }

    if (groupId && !state.groups.some((g) => g.id === groupId)) {
      return false;
    }

    if (groupId) {
      state.assignments[notebookId] = groupId;
    } else {
      delete state.assignments[notebookId];
    }
    saveState();
    refreshMainCategoryBar();
    return true;
  }

  function toggleFavorite(notebookId) {
    const index = state.favorites.indexOf(notebookId);
    if (index > -1) {
      state.favorites.splice(index, 1);
    } else {
      state.favorites.push(notebookId);
    }
    saveState();
  }

  // ========================================

  // ========================================

  function getEffectiveTheme(themeMode = state.theme) {
    if (themeMode === 'auto') {
      return systemThemeQuery.matches ? 'dark' : 'light';
    }
    return themeMode === 'dark' ? 'dark' : 'light';
  }

  function isLightTheme(themeMode = state.theme) {
    return getEffectiveTheme(themeMode) === 'light';
  }

  function applyTheme(sidebar) {
    if (isLightTheme()) {
      sidebar.classList.add('light-theme');
    } else {
      sidebar.classList.remove('light-theme');
    }
  }

  function refreshThemeFromSystem() {
    const sidebar = document.getElementById('flm-sidebar');
    if (sidebar) {
      applyTheme(sidebar);
    }
    const useLight = isLightTheme();
    document.querySelectorAll('.flm-modal-overlay').forEach((el) => {
      el.classList.toggle('light-theme', useLight);
    });
    document.querySelectorAll('.flm-modal').forEach((el) => {
      el.classList.toggle('light-theme', useLight);
    });
  }

  // ========================================

  // ========================================

  function createSidebar() {

    const existing = document.getElementById('flm-sidebar');
    if (existing) {
      existing.remove();
    }

    const sidebar = document.createElement('div');
    sidebar.id = 'flm-sidebar';
    

    const dynamicMaxWidth = Math.min(
      window.innerWidth * SIDEBAR_MAX_WIDTH_RATIO,
      SIDEBAR_MAX_WIDTH_ABSOLUTE
    );
    const adjustedWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(dynamicMaxWidth, state.sidebarWidth));
    sidebar.style.width = adjustedWidth + 'px';
    state.sidebarWidth = adjustedWidth;
    

    applyTheme(sidebar);

    sidebar.innerHTML = `
      <div id="flm-sidebar-header">
        <div id="flm-header-title-row">
          <h2>
            <svg class="flm-brand-mark" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3.5 16.8h17" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
              <path d="M4.6 16.8v-5.9a2.2 2.2 0 0 1 2.2-2.2h3l1.4 1.7h5.9a2.2 2.2 0 0 1 2.2 2.2v4.2" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M6.1 6.6a5.5 5.5 0 0 1 9.2 0" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>
            </svg>
            <span>FolderLM</span>
          </h2>
        </div>
        <div id="flm-search-container">
          <svg id="flm-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input type="text" id="flm-search-input" placeholder="Search Notebook">
        </div>
      </div>
      
      <div id="flm-groups-container"></div>
      
      <button id="flm-add-group-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        Create new folder
      </button>
      
      <div id="flm-sidebar-footer">
        <span id="flm-folder-count">Folders: 0</span>
        <span id="flm-notebook-count">Notebooks: 0</span>
      </div>
      
      <div id="flm-resize-handle" title="Drag to resize"></div>
    `;

    document.body.appendChild(sidebar);
    document.body.classList.add('flm-organizer-active');
    

    document.body.style.setProperty('--flm-sidebar-width', state.sidebarWidth + 'px');
    setupSidebarEvents(sidebar);
    

    updateGroupsList();
  }

  function setupSidebarEvents(sidebar) {
    const clampWidth = (width) => {
      const viewportMax = Math.min(
        window.innerWidth * SIDEBAR_MAX_WIDTH_RATIO,
        SIDEBAR_MAX_WIDTH_ABSOLUTE
      );
      return Math.max(SIDEBAR_MIN_WIDTH, Math.min(viewportMax, width));
    };

    const applyWidth = (width) => {
      sidebar.style.width = `${width}px`;
      document.body.style.setProperty('--flm-sidebar-width', `${width}px`);
    };

    const resizeHandle = sidebar.querySelector('#flm-resize-handle');
    if (resizeHandle) {
      resizeHandle.addEventListener('mousedown', (event) => {
        const startX = event.clientX;
        const initialWidth = sidebar.offsetWidth;
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        event.preventDefault();

        const onMouseMove = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          applyWidth(clampWidth(initialWidth + delta));
        };

        const onMouseUp = () => {
          document.removeEventListener('mousemove', onMouseMove);
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          state.sidebarWidth = sidebar.offsetWidth;
          saveState();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp, { once: true });
      });

      window.addEventListener('resize', () => {
        const adjusted = clampWidth(sidebar.offsetWidth);
        if (adjusted !== sidebar.offsetWidth) {
          applyWidth(adjusted);
          state.sidebarWidth = adjusted;
        }
      });
    }

    const searchInput = sidebar.querySelector('#flm-search-input');
    searchInput.addEventListener('input', ({ target }) => {
      state.searchQuery = target.value.toLowerCase();
      filterNotebooks();
      updateGroupsList(true);
    });

    const addFolderButton = sidebar.querySelector('#flm-add-group-btn');
    addFolderButton.addEventListener('click', showCreateGroupModal);

    sidebar.addEventListener('mouseenter', () => {
      state.sidebarHovered = true;
    });

    sidebar.addEventListener('mouseleave', () => {
      state.sidebarHovered = false;
      if (!state.pendingUpdate) return;
      log('Mouse left sidebar, executing pending update');
      updateGroupsList(true);
    });
  }

  function updateGroupsList(force = false) {
    const container = document.getElementById('flm-groups-container');
    if (!container) {
      refreshMainCategoryBar();
      return;
    }


    if (state.sidebarHovered && !force) {
      state.pendingUpdate = true;
      log('Sidebar hovered, deferring update');
      return;
    }


    if (state.notebooks.length === 0) {
      log('No notebooks in state, skipping update');
      refreshMainCategoryBar();
      return;
    }

    state.pendingUpdate = false;
    container.innerHTML = '';
    const grouped = getGroupedNotebooks();
    const renderedGroupIds = new Set();

    function getChildGroups(parentId) {
      return state.groups.filter((group) => (group.parentId || null) === (parentId || null));
    }

    function renderGroupTree(group, depth = 0) {
      if (renderedGroupIds.has(group.id)) return { html: '', count: 0 };
      renderedGroupIds.add(group.id);

      const notebooks = grouped.custom[group.id] || [];
      const ownCount = notebooks.filter((nb) =>
        !state.searchQuery || nb.title.toLowerCase().includes(state.searchQuery)
      ).length;

      const childResults = getChildGroups(group.id)
        .map((child) => renderGroupTree(child, depth + 1));
      const childrenHtml = childResults.map((result) => result.html).join('');
      const childCount = childResults.reduce((sum, result) => sum + result.count, 0);
      const totalCount = ownCount + childCount;

      return {
        html: createGroupHtml(group, notebooks, 'custom', depth, childrenHtml, totalCount),
        count: totalCount
      };
    }

    getChildGroups(null).forEach((rootGroup) => {
      const result = renderGroupTree(rootGroup, 0);
      if (result.html) container.insertAdjacentHTML('beforeend', result.html);
    });

    state.groups
      .filter((group) => !renderedGroupIds.has(group.id))
      .forEach((group) => {
        const result = renderGroupTree(group, 0);
        if (result.html) container.insertAdjacentHTML('beforeend', result.html);
      });

    const uncategorizedNotebooks = state.notebooks.filter((nb) => !state.assignments[nb.id]);
    if (uncategorizedNotebooks.length > 0) {
      const html = createGroupHtml({
        id: 'uncategorized',
        name: 'Uncategorized',
        color: '#000'
      }, uncategorizedNotebooks, 'uncategorized');
      container.insertAdjacentHTML('beforeend', html);
    }


    setupGroupEvents(container);

    refreshMainCategoryBar();

    updateStats();
  }

  function createGroupHtml(group, notebooks, type, depth = 0, childGroupsHtml = '', totalCount = null) {
    const isExpanded = state.expandedGroups[group.id] !== false;
    const filteredNotebooks = notebooks.filter(nb => 
      !state.searchQuery || nb.title.toLowerCase().includes(state.searchQuery)
    );
    const displayCount = totalCount == null ? filteredNotebooks.length : totalCount;
    const hasChildGroups = childGroupsHtml.trim().length > 0;
    const hasExpandableContent = filteredNotebooks.length > 0 || hasChildGroups;

    const notebooksHtml = filteredNotebooks.map(nb => `
      <div class="flm-notebook-item ${state.activeNotebookId === nb.id ? 'is-active' : ''}" 
           data-notebook-id="${nb.id}"
           draggable="true">
        <span class="flm-notebook-title" title="${nb.title}">${nb.title}</span>
      </div>
    `).join('');

    const actionsHtml = type === 'custom' ? `
      <div class="flm-group-actions">
        <button class="flm-group-action-btn edit-group" title="Edit folder">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z"></path>
            <path d="M14.06 6.19l3.75 3.75"></path>
          </svg>
        </button>
        <button class="flm-group-action-btn delete-group" title="Delete folder">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="M19 6l-1 14H6L5 6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
          </svg>
        </button>
      </div>
    ` : '';


    const dragHandleHtml = type === 'custom' ? `
      <div class="flm-group-drag-handle" title="Drag to reorder">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="5" r="2"></circle>
          <circle cx="15" cy="5" r="2"></circle>
          <circle cx="9" cy="12" r="2"></circle>
          <circle cx="15" cy="12" r="2"></circle>
          <circle cx="9" cy="19" r="2"></circle>
          <circle cx="15" cy="19" r="2"></circle>
        </svg>
      </div>
    ` : '';

    const expandControlHtml = hasExpandableContent ? `
      <div class="flm-group-expand">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9 18 15 12 9 6"></polyline>
        </svg>
      </div>
    ` : '<div class="flm-group-expand flm-group-expand-empty"></div>';

    return `
      <div class="flm-group-item ${type} ${depth > 0 ? 'is-subgroup' : 'is-rootgroup'} ${isExpanded ? 'expanded' : ''} ${hasExpandableContent ? '' : 'no-expand'}" 
           data-group-id="${group.id}"
           data-expandable="${hasExpandableContent ? '1' : '0'}"
           style="--flm-group-depth:${depth};">
        <div class="flm-group-header">
          ${dragHandleHtml}
          ${expandControlHtml}
          <div class="flm-group-color" style="background: ${group.color}"></div>
          <span class="flm-group-name">${group.name}</span>
          ${actionsHtml}
          <span class="flm-group-count">${displayCount}</span>
        </div>
        <div class="flm-group-content">
          ${filteredNotebooks.length > 0 ? notebooksHtml : ''}
          ${hasChildGroups ? `<div class="flm-subgroup-list">${childGroupsHtml}</div>` : ''}
          ${!hasExpandableContent ? '<div class="flm-empty-state">No notebooks</div>' : ''}
        </div>
      </div>
    `;
  }

  function setupGroupEvents(container) {

    container.querySelectorAll('.flm-group-header').forEach(header => {
      header.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.target.closest('.flm-group-actions')) return;

        const groupItem = header.closest('.flm-group-item');
        if (!groupItem || groupItem.dataset.expandable !== '1') return;
        const groupId = groupItem.dataset.groupId;
        const isExpanded = groupItem.classList.toggle('expanded');
        state.expandedGroups[groupId] = isExpanded;
        saveState();
      });
    });


    container.querySelectorAll('.edit-group').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupId = btn.closest('.flm-group-item').dataset.groupId;
        const group = state.groups.find(g => g.id === groupId);
        if (group) {
          showEditGroupModal(group);
        }
      });
    });


    container.querySelectorAll('.delete-group').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const groupId = btn.closest('.flm-group-item').dataset.groupId;
        if (confirm('Delete this group? (Notebooks will not be deleted)')) {
          deleteGroup(groupId);
          updateGroupsList(true);
          showToast('Group deleted');
        }
      });
    });


    container.querySelectorAll('.flm-notebook-item').forEach(item => {

      item.addEventListener('click', (e) => {
        const notebookId = item.dataset.notebookId;
        state.activeNotebookId = notebookId;
        container.querySelectorAll('.flm-notebook-item').forEach(node => node.classList.remove('is-active'));
        item.classList.add('is-active');
        const notebook = state.notebooks.find(nb => nb.id === notebookId);
        if (notebook && notebook.element) {
          notebook.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          notebook.element.classList.add('flm-notebook-card-highlight');
          setTimeout(() => {
            notebook.element.classList.remove('flm-notebook-card-highlight');
          }, 2000);
        }
      });
      

      item.addEventListener('dblclick', (e) => {
        const notebookId = item.dataset.notebookId;
        const notebook = state.notebooks.find(nb => nb.id === notebookId);
        if (notebook && notebook.element) {

          notebook.element.click();
        }
      });
    });


    setupDragAndDrop(container);
  }

  // ========================================

  // ========================================

  function setupDragAndDrop(container) {
    const dragState = {
      notebookId: null,
      groupId: null,
      ghost: null
    };

    const clearDropIndicators = () => {
      container.querySelectorAll('.flm-group-item').forEach((groupItem) => {
        groupItem.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
      });
    };

    const removeGhost = () => {
      if (!dragState.ghost) return;
      dragState.ghost.remove();
      dragState.ghost = null;
    };

    const spawnGhost = (text, extraClass = '') => {
      removeGhost();
      const ghost = document.createElement('div');
      ghost.className = `flm-drag-ghost ${extraClass}`.trim();
      ghost.textContent = text;
      document.body.appendChild(ghost);
      dragState.ghost = ghost;
    };

    const canStartGroupDrag = (header, event) => {
      const handle = header.querySelector('.flm-group-drag-handle');
      if (!handle) return false;

      const rect = handle.getBoundingClientRect();
      const withinX = event.clientX >= rect.left - 5 && event.clientX <= rect.right + 5;
      const withinY = event.clientY >= rect.top - 5 && event.clientY <= rect.bottom + 5;
      return withinX && withinY;
    };

    container.querySelectorAll('.flm-notebook-item').forEach((item) => {
      item.addEventListener('dragstart', (event) => {
        event.stopPropagation();
        dragState.notebookId = item.dataset.notebookId;
        dragState.groupId = null;
        item.classList.add('flm-dragging');

        const notebook = state.notebooks.find((entry) => entry.id === dragState.notebookId);
        if (notebook) spawnGhost(notebook.title);

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragState.notebookId);
        event.dataTransfer.setData('drag-type', 'notebook');
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('flm-dragging');
        dragState.notebookId = null;
        removeGhost();
        clearDropIndicators();
      });
    });

    container.querySelectorAll('.flm-group-item.custom > .flm-group-header').forEach((header) => {
      const groupItem = header.closest('.flm-group-item');
      header.setAttribute('draggable', 'true');

      header.addEventListener('dragstart', (event) => {
        if (!canStartGroupDrag(header, event)) {
          event.preventDefault();
          return;
        }

        event.stopPropagation();
        dragState.groupId = groupItem.dataset.groupId;
        dragState.notebookId = null;
        groupItem.classList.add('flm-group-dragging');

        const group = state.groups.find((entry) => entry.id === dragState.groupId);
        if (group) spawnGhost(group.name, 'flm-drag-ghost-group');

        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragState.groupId);
        event.dataTransfer.setData('drag-type', 'group');
      });

      header.addEventListener('dragend', () => {
        groupItem.classList.remove('flm-group-dragging');
        dragState.groupId = null;
        removeGhost();
        clearDropIndicators();
      });
    });

    const updateGroupDropPreview = (groupItem, clientY) => {
      const rect = groupItem.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      groupItem.classList.remove('drag-over-top', 'drag-over-bottom');
      groupItem.classList.add(clientY < midY ? 'drag-over-top' : 'drag-over-bottom');
    };

    container.querySelectorAll('.flm-group-item').forEach((groupItem) => {
      groupItem.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        if (dragState.groupId && groupItem.classList.contains('custom')) {
          updateGroupDropPreview(groupItem, event.clientY);
          return;
        }

        if (dragState.notebookId) groupItem.classList.add('drag-over');
      });

      groupItem.addEventListener('dragleave', (event) => {
        if (groupItem.contains(event.relatedTarget)) return;
        groupItem.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');
      });

      groupItem.addEventListener('drop', (event) => {
        event.preventDefault();
        groupItem.classList.remove('drag-over', 'drag-over-top', 'drag-over-bottom');

        const dragType = event.dataTransfer.getData('drag-type');
        const targetGroupId = groupItem.dataset.groupId;

        if (dragType === 'group' && dragState.groupId && groupItem.classList.contains('custom')) {
          if (dragState.groupId === targetGroupId) return;
          const rect = groupItem.getBoundingClientRect();
          const shouldInsertBefore = event.clientY < (rect.top + rect.height / 2);
          reorderGroup(dragState.groupId, targetGroupId, shouldInsertBefore);
          updateGroupsList(true);
          showToast('Group reordered');
          return;
        }

        const notebookId = event.dataTransfer.getData('text/plain');
        if (!notebookId || !targetGroupId || dragType === 'group') return;

        if (targetGroupId === 'uncategorized') {
          delete state.assignments[notebookId];
          saveState();
        } else if (targetGroupId.startsWith('date-')) {
          showToast('You cannot manually move items into date groups');
          return;
        } else {
          const assigned = assignToGroup(notebookId, targetGroupId);
          if (!assigned) {
            showToast('Folders are only available for My notebooks');
            return;
          }
        }

        updateGroupsList(true);
        updateNotebookCards();
        showToast('Notebook moved');
      });
    });

    if (dragGhostMoveHandler) {
      document.removeEventListener('dragover', dragGhostMoveHandler);
    }
    dragGhostMoveHandler = (event) => {
      if (!dragState.ghost) return;
      dragState.ghost.style.left = `${event.clientX + 10}px`;
      dragState.ghost.style.top = `${event.clientY + 10}px`;
    };
    document.addEventListener('dragover', dragGhostMoveHandler);

    setupMainAreaDrag();
  }


  function reorderGroup(draggedId, targetId, insertBefore) {
    const draggedIndex = state.groups.findIndex(g => g.id === draggedId);
    const targetIndex = state.groups.findIndex(g => g.id === targetId);
    
    if (draggedIndex === -1 || targetIndex === -1) return;
    

    const [draggedGroup] = state.groups.splice(draggedIndex, 1);
    

    let newIndex = state.groups.findIndex(g => g.id === targetId);
    if (!insertBefore) {
      newIndex += 1;
    }
    

    state.groups.splice(newIndex, 0, draggedGroup);
    
    saveState();
  }

  function setupMainAreaDrag() {
    state.notebooks.forEach(notebook => {
      const card = notebook.element;
      if (!card || card.getAttribute('data-flm-drag-setup')) return;

      if (notebook.manageable === false) {
        card.removeAttribute('draggable');
        return;
      }

      card.setAttribute('draggable', 'true');
      card.setAttribute('data-flm-drag-setup', 'true');

      card.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', notebook.id);
        card.classList.add('flm-dragging');

        const dragGhost = document.createElement('div');
        dragGhost.className = 'flm-drag-ghost';
        dragGhost.textContent = notebook.title;
        dragGhost.id = 'flm-main-drag-ghost';
        document.body.appendChild(dragGhost);
      });

      card.addEventListener('dragend', () => {
        card.classList.remove('flm-dragging');
        const ghost = document.getElementById('flm-main-drag-ghost');
        if (ghost) ghost.remove();
        document.querySelectorAll('.flm-group-item').forEach(g => {
          g.classList.remove('drag-over');
        });
      });
    });


    document.addEventListener('dragover', (e) => {
      const ghost = document.getElementById('flm-main-drag-ghost');
      if (ghost) {
        ghost.style.left = `${e.clientX + 10}px`;
        ghost.style.top = `${e.clientY + 10}px`;
      }
    });
  }

  // ========================================

  // ========================================

  function getMainFilterTarget() {
    const validIds = new Set(state.groups.map(g => g.id));
    if (state.mainFilterGroupId === 'all' || validIds.has(state.mainFilterGroupId)) {
      return state.mainFilterGroupId;
    }
    state.mainFilterGroupId = 'all';
    return 'all';
  }

  function getDisplayCategoryName(name) {
    const normalized = String(name || '').trim();
    const labelMap = {
      'Todos': 'All',
      'Todo': 'All',
      'Categorias': 'Folders',
      'Categoria': 'Category',
      'Autoescola': 'Driving School'
    };
    return labelMap[normalized] || normalized;
  }

  function removeMainCategoryBar() {
    const existing = document.getElementById('flm-main-category-bar');
    if (existing) existing.remove();
    removeTopCategoryButtons();
    for (const container of Array.from(compactContainers)) {
      setContainerCompactMode(container, false);
      compactContainers.delete(container);
    }
  }

  function removeTopCategoryButtons() {
    const newBtn = document.getElementById('flm-top-new-category-btn');
    if (newBtn) newBtn.remove();
    const manageBtn = document.getElementById('flm-top-manage-category-btn');
    if (manageBtn) manageBtn.remove();
  }

  function renderTopNewCategoryButton() {
    const controlsRow = document.querySelector('.project-filter-create-container');
    if (!controlsRow || window.location.pathname.includes('/notebook/')) {
      removeTopCategoryButtons();
      return;
    }

    let manageBtn = document.getElementById('flm-top-manage-category-btn');
    if (!manageBtn) {
      manageBtn = document.createElement('button');
      manageBtn.id = 'flm-top-manage-category-btn';
      manageBtn.type = 'button';
      manageBtn.textContent = 'Manage folders';
      manageBtn.addEventListener('click', () => showManageFoldersModal());
    }

    let btn = document.getElementById('flm-top-new-category-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'flm-top-new-category-btn';
      btn.type = 'button';
      btn.innerHTML = `
        <span class="flm-top-new-category-plus">+</span>
        New folder
      `;
      btn.addEventListener('click', () => showCreateGroupModal());
    }

    if (manageBtn.parentElement !== controlsRow) {
      controlsRow.appendChild(manageBtn);
    }
    if (btn.parentElement !== controlsRow) {
      controlsRow.appendChild(btn);
    }
  }

  function getMainFilterMountPoint() {
    const topControls = document.querySelector('.project-filter-create-container');
    if (topControls) {
      let rowContainer = topControls.parentElement;
      let mountParent = rowContainer ? rowContainer.parentElement : null;

      // Move up until we escape horizontal flex rows, so category bar renders on a new row below controls.
      while (rowContainer && mountParent) {
        const style = window.getComputedStyle(mountParent);
        const isHorizontalFlex = style.display.includes('flex') && (style.flexDirection === 'row' || style.flexDirection === 'row-reverse');
        if (!isHorizontalFlex || !mountParent.parentElement) break;
        rowContainer = mountParent;
        mountParent = mountParent.parentElement;
      }

      if (rowContainer && mountParent) {
        return {
          mountParent,
          beforeNode: rowContainer.nextElementSibling
        };
      }
    }

    const firstNotebook = state.notebooks.find(nb => nb.element)?.element;
    if (!firstNotebook) return null;

    let listRoot = firstNotebook.closest(
      '.project-buttons-flow, .cdk-virtual-scroll-content-wrapper, table, tbody, [role="grid"], [role="list"], .mat-mdc-table'
    );
    if (!listRoot) {
      listRoot = firstNotebook.parentElement;
    }
    if (!listRoot) return null;

    const tag = listRoot.tagName;
    if (tag === 'TBODY' || tag === 'TR' || tag === 'THEAD') {
      const table = listRoot.closest('table');
      if (table && table.parentElement) {
        return { mountParent: table.parentElement, beforeNode: table };
      }
    }
    if (tag === 'TABLE') {
      return { mountParent: listRoot.parentElement, beforeNode: listRoot };
    }
    if (!listRoot.parentElement) return null;

    let mountParent = listRoot.parentElement;
    let probe = mountParent;
    const baseWidth = listRoot.getBoundingClientRect().width || 0;
    while (probe && probe.parentElement && probe !== document.body) {
      const width = probe.getBoundingClientRect().width || 0;
      if (width >= baseWidth * 1.2) {
        mountParent = probe;
      }
      if (probe.matches('main, [role="main"]')) {
        mountParent = probe;
        break;
      }
      probe = probe.parentElement;
    }

    return { mountParent, beforeNode: mountParent.firstElementChild || null };
  }

  function renderMainCategoryBar() {
    const mountPoint = getMainFilterMountPoint();
    let container = document.getElementById('flm-main-category-bar');

    if (!mountPoint || !mountPoint.mountParent || state.notebooks.length === 0) {
      removeMainCategoryBar();
      return;
    }

    if (container && container.parentElement !== mountPoint.mountParent) {
      container.remove();
      container = null;
    }

    const activeFilter = getMainFilterTarget();
    const manageableNotebooks = getManageableNotebooks();
    const totalCount = manageableNotebooks.length;

    function renderGroupPill(group, depth, hasSubfolder = false) {
      const includedGroupIds = new Set([group.id, ...Array.from(getGroupDescendantIds(group.id))]);
      const count = manageableNotebooks.filter(nb => includedGroupIds.has(state.assignments[nb.id])).length;
      const displayName = getDisplayCategoryName(group.name);
      return `
        <div class="category-pill flm-main-filter-btn ${activeFilter === group.id ? 'active' : ''} ${depth > 0 ? 'is-subfolder' : ''}"
             data-filter-group="${group.id}"
             style="--flm-pill-badge-bg:${group.color};--flm-main-filter-depth:${depth};"
             title="${displayName}">
          <button class="flm-main-filter-main"
                  data-filter-group="${group.id}"
                  type="button"
                  role="tab"
                  aria-selected="${activeFilter === group.id ? 'true' : 'false'}">
            <span class="label">${displayName}</span>
            <span class="count inline-text">${count}</span>
          </button>
          ${hasSubfolder ? `
            <button class="flm-main-filter-toggle"
                    data-parent-group="${group.id}"
                    aria-expanded="false"
                    type="button"
                    title="Show subfolders">▾</button>
          ` : ''}
        </div>
      `;
    }

    function flattenSubgroups(parentId, depth = 1) {
      const directChildren = state.groups.filter((group) => (group.parentId || null) === parentId);
      let items = [];
      directChildren.forEach((child) => {
        items.push({ group: child, depth });
        items = items.concat(flattenSubgroups(child.id, depth + 1));
      });
      return items;
    }

    const rootGroups = state.groups.filter((group) => !group.parentId);
    const groupsHtml = rootGroups.map((group) => {
      const nested = flattenSubgroups(group.id, 1);
      const hasSubfolder = nested.length > 0;
      const nestedHtml = nested.map(({ group: sub, depth }) => {
        const includedGroupIds = new Set([sub.id, ...Array.from(getGroupDescendantIds(sub.id))]);
        const count = manageableNotebooks.filter(nb => includedGroupIds.has(state.assignments[nb.id])).length;
        const displayName = getDisplayCategoryName(sub.name);
        return `
          <button class="flm-main-submenu-item ${activeFilter === sub.id ? 'active' : ''}"
                  data-filter-group="${sub.id}"
                  style="--flm-sub-depth:${depth};--flm-pill-badge-bg:${sub.color};"
                  type="button">
            <span class="label">${displayName}</span>
            <span class="count">${count}</span>
          </button>
        `;
      }).join('');

      return `
        <div class="flm-main-filter-wrap" data-parent-group="${group.id}">
          ${renderGroupPill(group, 0, hasSubfolder)}
          ${hasSubfolder ? `
            <div class="flm-main-submenu" data-parent-group="${group.id}">
              ${nestedHtml}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    if (!container) {
      container = document.createElement('div');
      container.id = 'flm-main-category-bar';
      if (mountPoint.beforeNode) {
        mountPoint.mountParent.insertBefore(container, mountPoint.beforeNode);
      } else {
        mountPoint.mountParent.appendChild(container);
      }
    }

    container.innerHTML = `
      <div class="flm-main-filter-row">
        <div class="flm-main-filter-title">Folders</div>
        <div class="flm-main-filter-list" role="tablist" aria-label="Folders">
          <div class="category-pill flm-main-filter-btn ${activeFilter === 'all' ? 'active' : ''}"
               data-filter-group="all"
               style="--flm-pill-badge-bg:var(--flm-cat-badge-bg);"
               title="All">
            <button class="flm-main-filter-main"
                    data-filter-group="all"
                    type="button"
                    role="tab"
                    aria-selected="${activeFilter === 'all' ? 'true' : 'false'}">
              <span class="label">All</span>
              <span class="count inline-text">${totalCount}</span>
            </button>
          </div>
          ${groupsHtml}
        </div>
      </div>
    `;

    if (!container.dataset.bound) {
      setupMainCategoryBarEvents(container);
      container.dataset.bound = '1';
    }
  }

  function setupMainCategoryBarEvents(container) {
    function closeSubmenus() {
      container.querySelectorAll('.flm-main-filter-wrap.open').forEach((wrap) => {
        wrap.classList.remove('open');
      });
      container.querySelectorAll('.flm-main-filter-toggle').forEach((btn) => {
        btn.setAttribute('aria-expanded', 'false');
      });
    }

    container.addEventListener('click', (e) => {
      const moreBtn = e.target.closest('.flm-main-filter-toggle');
      if (moreBtn && container.contains(moreBtn)) {
        e.preventDefault();
        e.stopPropagation();
        const wrap = moreBtn.closest('.flm-main-filter-wrap');
        const willOpen = !wrap.classList.contains('open');
        closeSubmenus();
        if (willOpen) {
          wrap.classList.add('open');
          moreBtn.setAttribute('aria-expanded', 'true');
        }
        return;
      }

      const submenuItem = e.target.closest('.flm-main-submenu-item');
      if (submenuItem && container.contains(submenuItem)) {
        const groupId = submenuItem.dataset.filterGroup;
        if (!groupId) return;
        state.mainFilterGroupId = groupId;
        closeSubmenus();
        refreshMainCategoryBar();
        saveState();
        return;
      }

      const mainBtn = e.target.closest('.flm-main-filter-main');
      if (!mainBtn || !container.contains(mainBtn)) return;
      const groupId = mainBtn.dataset.filterGroup || 'all';
      state.mainFilterGroupId = groupId;
      closeSubmenus();
      container.querySelectorAll('.flm-main-filter-main').forEach(node => {
        node.setAttribute('aria-selected', node === mainBtn ? 'true' : 'false');
      });
      refreshMainCategoryBar();
      saveState();
    });

    if (!container.dataset.outsideCloseBound) {
      document.addEventListener('click', (e) => {
        if (!container.isConnected) return;
        if (container.contains(e.target)) return;
        closeSubmenus();
      }, true);
      container.dataset.outsideCloseBound = '1';
    }

    container.addEventListener('dragover', (e) => {
      const btn = e.target.closest('.flm-main-filter-btn');
      if (!btn || !container.contains(btn)) return;
      const groupId = btn.dataset.filterGroup;
      if (!groupId || groupId === 'all') return;
      e.preventDefault();
      btn.classList.add('drag-over');
    });

    container.addEventListener('dragleave', (e) => {
      const btn = e.target.closest('.flm-main-filter-btn');
      if (!btn || !container.contains(btn)) return;
      btn.classList.remove('drag-over');
    });

    container.addEventListener('drop', (e) => {
      const btn = e.target.closest('.flm-main-filter-btn');
      if (!btn || !container.contains(btn)) return;
      btn.classList.remove('drag-over');
      const groupId = btn.dataset.filterGroup;
      if (!groupId || groupId === 'all') return;

      e.preventDefault();
      const notebookId = e.dataTransfer.getData('text/plain');
      if (!notebookId) return;

      const ok = assignToGroup(notebookId, groupId);
      if (!ok) {
        showToast('Folders are only available for My notebooks');
        return;
      }
      updateNotebookCards();
      updateGroupsList(true);
      showToast('Notebook moved');
    });
  }

  function notebookMatchesMainFilter(notebook) {
    const target = getMainFilterTarget();
    if (target === 'all') return true;
    const assigned = state.assignments[notebook.id];
    if (!assigned) return false;
    if (assigned === target) return true;
    return getGroupDescendantIds(target).has(assigned);
  }

  function getNotebookLayoutItemElement(notebook) {
    if (!notebook || !notebook.element) return null;
    return resolveNotebookElement(notebook.element);
  }

  function getFeaturedHeadingElements() {
    const featuredKeywords = ['featured notebook', 'featured notebooks', 'notebooks em destaque', 'notebooks destacados'];
    const headingSelectors = ['h1', 'h2', 'h3', '[role="heading"]'];
    return Array.from(document.querySelectorAll(headingSelectors.join(','))).filter((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      return featuredKeywords.some((k) => text.includes(k));
    });
  }

  function findFeaturedSectionRoot(heading) {
    if (!heading) return null;
    let current = heading.parentElement;
    while (current && current !== document.body) {
      const hasNotebookCards = !!current.querySelector('project-button, .project-card, [class*="notebook-card"], mat-card');
      const hasRecentHeading = Array.from(current.querySelectorAll('h1, h2, h3, [role="heading"]'))
        .some((el) => /recent notebooks|notebooks recentes|notebooks recientes/i.test((el.textContent || '').toLowerCase()));

      if (hasNotebookCards && !hasRecentHeading) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function setFeaturedSectionVisibility(visible) {
    const headings = getFeaturedHeadingElements();
    headings.forEach((heading) => {
      setFilterVisibility(heading, visible);

      // Hide common action buttons in featured header row (e.g., "See all")
      const row = heading.parentElement;
      if (row) {
        const candidates = row.querySelectorAll('button, a');
        candidates.forEach((el) => setFilterVisibility(el, visible));
      }

      const strictSection = findFeaturedSectionRoot(heading);
      if (strictSection) {
        setFilterVisibility(strictSection, visible);
      } else {
        const looseSection = heading.closest('section, [class*="featured"], [class*="section"]');
        if (looseSection) {
          setFilterVisibility(looseSection, visible);
        }
      }
    });
  }

  function setSeeAllVisibility(visible) {
    const targets = Array.from(document.querySelectorAll('a, button')).filter((el) => {
      const text = (el.textContent || '').trim().toLowerCase();
      const aria = (el.getAttribute('aria-label') || '').trim().toLowerCase();
      const isSeeAllText = text === 'see all' || text === 'ver tudo' || text === 'ver todo' || text === 'ver todos';
      const isSeeAllAria = aria.includes('see all') || aria.includes('ver tudo') || aria.includes('ver todos');
      return isSeeAllText || isSeeAllAria;
    });
    targets.forEach((el) => setFilterVisibility(el, visible));
  }

  function getNotebookHideTargets(notebook) {
    const base = getNotebookLayoutItemElement(notebook);
    if (!base) return [];

    const targets = [base];
    let parent = base.parentElement;
    let depth = 0;

    while (parent && parent !== document.body && depth < 4) {
      const cs = window.getComputedStyle(parent);
      const isLayoutContainer = cs.display.includes('flex') || cs.display.includes('grid') || parent.matches('tbody');
      if (isLayoutContainer) break;
      if (parent.children.length === 1) {
        targets.push(parent);
      }
      parent = parent.parentElement;
      depth += 1;
    }

    return [...new Set(targets)];
  }

  function findNearestLayoutContainer(node) {
    let current = node ? node.parentElement : null;
    while (current && current !== document.body) {
      const cs = window.getComputedStyle(current);
      const isFlexWrap = cs.display.includes('flex') && cs.flexWrap !== 'nowrap';
      const isGrid = cs.display.includes('grid');
      if (isFlexWrap || isGrid || current.matches('.project-buttons-flow, .cdk-virtual-scroll-content-wrapper, [role="grid"], [role="list"], tbody')) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function setFilterVisibility(target, visible) {
    if (!target) return;

    if (!visible) {
      if (target.dataset.flmFilterHidden === '1') return;
      target.dataset.flmFilterHidden = '1';
      if (target.style.display) {
        target.dataset.flmPrevDisplay = target.style.display;
      }
      target.hidden = true;
      target.style.setProperty('display', 'none', 'important');
      return;
    }

    if (target.dataset.flmFilterHidden !== '1') return;
    target.hidden = false;
    if (Object.prototype.hasOwnProperty.call(target.dataset, 'flmPrevDisplay')) {
      target.style.display = target.dataset.flmPrevDisplay || '';
      delete target.dataset.flmPrevDisplay;
    } else {
      target.style.removeProperty('display');
    }
    delete target.dataset.flmFilterHidden;
  }

  function setContainerCompactMode(container, enabled) {
    if (!container) return;
    if (enabled) {
      if (container.dataset.flmCompactMode === '1') return;
      const cs = window.getComputedStyle(container);
      container.dataset.flmCompactMode = '1';
      container.dataset.flmPrevJustify = container.style.justifyContent || '';
      container.dataset.flmPrevGap = container.style.gap || '';
      container.dataset.flmPrevAlignContent = container.style.alignContent || '';
      container.dataset.flmPrevGridAutoFlow = container.style.gridAutoFlow || '';

      if (cs.display.includes('flex')) {
        container.style.justifyContent = 'flex-start';
        container.style.alignContent = 'flex-start';
        if (!container.style.gap) {
          container.style.gap = '16px';
        }
      }
      if (cs.display.includes('grid')) {
        container.style.gridAutoFlow = 'row dense';
      }
      return;
    }

    if (container.dataset.flmCompactMode !== '1') return;
    container.style.justifyContent = container.dataset.flmPrevJustify || '';
    container.style.gap = container.dataset.flmPrevGap || '';
    container.style.alignContent = container.dataset.flmPrevAlignContent || '';
    container.style.gridAutoFlow = container.dataset.flmPrevGridAutoFlow || '';
    delete container.dataset.flmPrevJustify;
    delete container.dataset.flmPrevGap;
    delete container.dataset.flmPrevAlignContent;
    delete container.dataset.flmPrevGridAutoFlow;
    delete container.dataset.flmCompactMode;
  }

  function applyMainAreaFilters() {
    const query = state.searchQuery;
    let changed = false;
    const containers = new Set();
    const target = getMainFilterTarget();
    const showFeatured = target === 'all';

    state.notebooks.forEach(notebook => {
      if (notebook.manageable === false) {
        const targets = getNotebookHideTargets(notebook);
        targets.forEach((targetEl) => {
          const wasHidden = targetEl.dataset.flmFilterHidden === '1';
          const matchesFeaturedSearch = !query || notebook.title.toLowerCase().includes(query);
          const shouldShow = showFeatured && matchesFeaturedSearch;
          setFilterVisibility(targetEl, shouldShow);
          targetEl.classList.remove('flm-notebook-card-hidden');
          if (wasHidden !== !shouldShow) changed = true;
        });
        return;
      }

      const targets = getNotebookHideTargets(notebook);
      if (!targets.length) return;

      const matchesSearch = !query || notebook.title.toLowerCase().includes(query);
      const matchesGroup = notebookMatchesMainFilter(notebook);
      const matches = matchesSearch && matchesGroup;

      targets.forEach((targetEl) => {
        const wasHidden = targetEl.dataset.flmFilterHidden === '1';
        setFilterVisibility(targetEl, matches);
        targetEl.classList.toggle('flm-notebook-card-hidden', !matches);
        if (wasHidden !== !matches) {
          changed = true;
        }
      });

      const rootEl = targets[0];
      const container = findNearestLayoutContainer(rootEl);
      if (container) {
        containers.add(container);
      }

      if (matches && query && rootEl) {
        rootEl.classList.add('flm-notebook-card-highlight');
        setTimeout(() => {
          rootEl.classList.remove('flm-notebook-card-highlight');
        }, 500);
      }
    });

    setFeaturedSectionVisibility(showFeatured);
    setSeeAllVisibility(showFeatured);

    const hasAnyFilter = target !== 'all' || !!query;
    if (hasAnyFilter) {
      containers.forEach((container) => {
        setContainerCompactMode(container, true);
        compactContainers.add(container);
      });
      for (const container of Array.from(compactContainers)) {
        if (!containers.has(container)) {
          setContainerCompactMode(container, false);
          compactContainers.delete(container);
        }
      }
    } else {
      for (const container of Array.from(compactContainers)) {
        setContainerCompactMode(container, false);
        compactContainers.delete(container);
      }
    }

    // Trigger host layout recalculation after filtering to avoid ghost spacing.
    if (changed) {
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
  }

  function refreshMainCategoryBar() {
    renderMainCategoryBar();
    renderTopNewCategoryButton();
    applyMainAreaFilters();
  }

  function filterNotebooks() {
    applyMainAreaFilters();
  }

  // ========================================

  // ========================================

  function showCreateGroupModal() {
    showGroupModal({
      title: 'Create new folder',
      name: '',
      color: COLORS[0],
      parentId: null,
      onSave: (name, color, parentId) => {
        createGroupWithParent(name, color, parentId);
        updateGroupsList(true);
        showToast('Folder created');
      }
    });
  }

  function showCreateGroupForNotebook(notebookId, parentId = null, isSubfolder = false) {
    showGroupModal({
      title: isSubfolder ? 'Create new subfolder' : 'Create new folder',
      name: '',
      color: COLORS[0],
      parentId,
      onSave: (name, color, selectedParentId) => {
        const group = createGroupWithParent(name, color, selectedParentId);
        const ok = assignToGroup(notebookId, group.id);
        if (!ok) {
          showToast('Folders are only available for My notebooks');
          return;
        }
        updateGroupsList(true);
        updateNotebookCards();
        showToast('Moved to new folder');
      }
    });
  }

  function closeNotebookFolderMenu() {
    const existing = document.getElementById('flm-notebook-folder-menu');
    if (existing) existing.remove();
    document.removeEventListener('click', handleNotebookFolderMenuOutsideClick, true);
    document.removeEventListener('keydown', handleNotebookFolderMenuEsc, true);
  }

  function handleNotebookFolderMenuOutsideClick(e) {
    const menu = document.getElementById('flm-notebook-folder-menu');
    if (!menu) return;
    if (menu.contains(e.target)) return;
    if (e.target.closest('.flm-group-label')) return;
    closeNotebookFolderMenu();
  }

  function handleNotebookFolderMenuEsc(e) {
    if (e.key === 'Escape') {
      closeNotebookFolderMenu();
    }
  }

  function openNotebookFolderMenu(notebookId, anchorEl) {
    const existing = document.getElementById('flm-notebook-folder-menu');
    if (existing && existing.dataset.notebookId === notebookId) {
      closeNotebookFolderMenu();
      return;
    }
    closeNotebookFolderMenu();

    const notebook = state.notebooks.find(n => n.id === notebookId);
    if (!notebook || notebook.manageable === false) return;

    const menu = document.createElement('div');
    menu.id = 'flm-notebook-folder-menu';
    menu.className = 'flm-notebook-folder-menu';
    menu.dataset.notebookId = notebookId;

    const assignedGroupId = state.assignments[notebookId] || null;
    const groupsSorted = getOrderedGroupsWithDepth();

    const noFolderItem = document.createElement('button');
    noFolderItem.type = 'button';
    noFolderItem.className = `flm-notebook-folder-menu-item ${assignedGroupId ? '' : 'active'}`;
    noFolderItem.innerHTML = `
      <span class="flm-notebook-folder-menu-color flm-notebook-folder-menu-color-empty"></span>
      <span class="flm-notebook-folder-menu-name">No folder</span>
      ${assignedGroupId ? '' : '<span class="flm-notebook-folder-menu-check">✓</span>'}
    `;
    noFolderItem.addEventListener('click', () => {
      assignToGroup(notebookId, null);
      updateGroupsList(true);
      updateNotebookCards();
      closeNotebookFolderMenu();
      showToast('Folder removed');
    });
    menu.appendChild(noFolderItem);

    groupsSorted.forEach(({ group, depth }) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `flm-notebook-folder-menu-item ${assignedGroupId === group.id ? 'active' : ''}`;
      item.style.paddingLeft = `${10 + depth * 14}px`;
      item.innerHTML = `
        <span class="flm-notebook-folder-menu-color" style="background:${group.color}"></span>
        <span class="flm-notebook-folder-menu-name">${depth > 0 ? '' : ''}${group.name}</span>
        ${assignedGroupId === group.id ? '<span class="flm-notebook-folder-menu-check">✓</span>' : ''}
      `;
      item.addEventListener('click', () => {
        const ok = assignToGroup(notebookId, group.id);
        if (!ok) {
          showToast('Folders are only available for My notebooks');
          return;
        }
        updateGroupsList(true);
        updateNotebookCards();
        closeNotebookFolderMenu();
        showToast('Notebook moved');
      });
      menu.appendChild(item);
    });

    const divider = document.createElement('div');
    divider.className = 'flm-notebook-folder-menu-divider';
    menu.appendChild(divider);

    const createItem = document.createElement('button');
    createItem.type = 'button';
    createItem.className = 'flm-notebook-folder-menu-item create';
    createItem.innerHTML = `
      <span class="flm-notebook-folder-menu-plus">+</span>
      <span class="flm-notebook-folder-menu-name">New folder</span>
    `;
    createItem.addEventListener('click', () => {
      closeNotebookFolderMenu();
      showCreateGroupForNotebook(notebookId);
    });
    menu.appendChild(createItem);

    if (assignedGroupId) {
      const createSubItem = document.createElement('button');
      createSubItem.type = 'button';
      createSubItem.className = 'flm-notebook-folder-menu-item create';
      createSubItem.innerHTML = `
        <span class="flm-notebook-folder-menu-plus">+</span>
        <span class="flm-notebook-folder-menu-name">New subfolder here</span>
      `;
      createSubItem.addEventListener('click', () => {
        closeNotebookFolderMenu();
        showCreateGroupForNotebook(notebookId, assignedGroupId, true);
      });
      menu.appendChild(createSubItem);
    }

    document.body.appendChild(menu);

    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const spaceAbove = anchorRect.top;
    const shouldOpenUp = spaceBelow < menuRect.height + 12 && spaceAbove > menuRect.height + 12;

    let top;
    if (shouldOpenUp) {
      top = Math.max(8, anchorRect.top - menuRect.height - 6);
      menu.classList.add('open-up');
    } else {
      top = Math.min(window.innerHeight - menuRect.height - 8, anchorRect.bottom + 6);
      menu.classList.add('open-down');
    }

    const left = Math.min(window.innerWidth - menuRect.width - 8, Math.max(8, anchorRect.left));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    requestAnimationFrame(() => menu.classList.add('open'));

    setTimeout(() => {
      document.addEventListener('click', handleNotebookFolderMenuOutsideClick, true);
      document.addEventListener('keydown', handleNotebookFolderMenuEsc, true);
    }, 0);
  }

  function showEditGroupModal(group, options = {}) {
    showGroupModal({
      title: 'Edit folder',
      name: group.name,
      color: group.color,
      parentId: group.parentId || null,
      excludeGroupId: group.id,
      onCancel: options.onCancel,
      onSave: (name, color, parentId) => {
        renameGroup(group.id, name);
        updateGroupColor(group.id, color);
        updateGroupParent(group.id, parentId);
        updateGroupsList(true);
        showToast('Folder updated');
        if (typeof options.onSaved === 'function') {
          options.onSaved();
        }
      }
    });
  }

  function showManageFoldersModal() {
    const existing = document.getElementById('flm-manage-folders-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'flm-manage-folders-overlay';
    overlay.className = 'flm-modal-overlay';
    if (isLightTheme()) {
      overlay.classList.add('light-theme');
    }

    overlay.innerHTML = `
      <div class="flm-modal flm-manage-folders-modal ${isLightTheme() ? 'light-theme' : ''}">
        <div class="flm-manage-folders-header">
          <h3>Manage folders</h3>
          <button class="flm-manage-folders-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="flm-manage-folders-list"></div>
        <div class="flm-modal-actions">
          <button class="flm-modal-btn cancel flm-manage-folders-close-btn">Close</button>
          <button class="flm-modal-btn primary flm-manage-folders-create">+ New folder</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('.flm-manage-folders-list');
    const manageableNotebooks = getManageableNotebooks();

    function renderList() {
      const ordered = getOrderedGroupsWithDepth();
      if (!ordered.length) {
        listEl.innerHTML = `<div class="flm-manage-folders-empty">No folders yet.</div>`;
        return;
      }
      listEl.innerHTML = ordered.map(({ group, depth }) => {
        const count = manageableNotebooks.filter((nb) => state.assignments[nb.id] === group.id).length;
        return `
          <div class="flm-manage-folder-row" data-group-id="${group.id}" style="--flm-folder-depth:${depth};">
            <div class="flm-manage-folder-main">
              <span class="flm-manage-folder-color" style="background:${group.color};"></span>
              <span class="flm-manage-folder-name">${group.name}</span>
              <span class="flm-manage-folder-count">${count}</span>
            </div>
            <div class="flm-manage-folder-actions">
              <button type="button" class="flm-modal-btn cancel small" data-action="edit">Edit</button>
              <button type="button" class="flm-modal-btn cancel small danger" data-action="delete">Delete</button>
            </div>
          </div>
        `;
      }).join('');
    }

    function closeModal() {
      overlay.remove();
    }

    renderList();

    listEl.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (!actionBtn) return;
      const row = actionBtn.closest('.flm-manage-folder-row');
      if (!row) return;
      const groupId = row.dataset.groupId;
      const group = state.groups.find((g) => g.id === groupId);
      if (!group) return;

      const action = actionBtn.dataset.action;
      if (action === 'edit') {
        closeModal();
        showEditGroupModal(group, { onCancel: showManageFoldersModal });
        return;
      }
      if (action === 'delete') {
        if (!confirm(`Delete folder "${group.name}"? Notebooks will not be deleted.`)) return;
        deleteGroup(group.id);
        updateGroupsList(true);
        updateNotebookCards();
        renderList();
        showToast('Folder deleted');
      }
    });

    overlay.querySelector('.flm-manage-folders-close').addEventListener('click', closeModal);
    overlay.querySelector('.flm-manage-folders-close-btn').addEventListener('click', closeModal);
    overlay.querySelector('.flm-manage-folders-create').addEventListener('click', () => {
      closeModal();
      showCreateGroupModal();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
  }

  function showGroupModal({ title, name, color, parentId = null, excludeGroupId = null, onSave, onCancel }) {
    const overlay = document.createElement('div');
    overlay.className = 'flm-modal-overlay';
    

    const theme = state.theme;
    if (isLightTheme(theme)) {
      overlay.classList.add('light-theme');
    }

    const isPresetColor = COLORS.includes(color);
    const initialCustomColor = isPresetColor ? '#000000' : color;
    const colorOptions = COLORS.map(c => `
      <div class="flm-color-option ${c === color ? 'selected' : ''}" 
           data-color="${c}" 
           style="background: ${c}"></div>
    `).join('');

    const parentOptions = [{ id: '', name: 'New Main Folder', depth: 0 }];
    getOrderedGroupsWithDepth().forEach(({ group, depth }) => {
      if (excludeGroupId && (group.id === excludeGroupId || isDescendantGroup(group.id, excludeGroupId))) {
        return;
      }
      parentOptions.push({ id: group.id, name: group.name, depth });
    });

    const parentSelectHtml = `
      <select class="flm-modal-input flm-modal-select">
        ${parentOptions.map(opt => `
          <option value="${opt.id}" ${String(parentId || '') === opt.id ? 'selected' : ''}>
            ${'  '.repeat(opt.depth)}${opt.name}
          </option>
        `).join('')}
      </select>
    `;

    overlay.innerHTML = `
      <div class="flm-modal ${isLightTheme(theme) ? 'light-theme' : ''}">
        <h3>${title}</h3>
        <input type="text" class="flm-modal-input" placeholder="Folder name" value="${name}">
        ${parentSelectHtml}
        <div class="flm-color-picker">
          ${colorOptions}
          <label class="flm-color-option flm-color-option-custom ${isPresetColor ? '' : 'selected'}" data-color="${initialCustomColor}" style="--flm-custom-color:${initialCustomColor};" title="Custom color">
            <input type="color" class="flm-color-inline-input" value="${initialCustomColor}">
            <span>+</span>
          </label>
        </div>
        <div class="flm-modal-actions">
          <button class="flm-modal-btn cancel">Cancel</button>
          <button class="flm-modal-btn primary">Save</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = overlay.querySelector('.flm-modal-input');
    const parentSelect = overlay.querySelector('.flm-modal-select');
    const customColorBtn = overlay.querySelector('.flm-color-option-custom');
    const inlineColorInput = overlay.querySelector('.flm-color-inline-input');
    let selectedColor = color;

    function selectColor(optionEl, value) {
      overlay.querySelectorAll('.flm-color-option').forEach(o => o.classList.remove('selected'));
      optionEl.classList.add('selected');
      selectedColor = value;
    }

    overlay.querySelectorAll('.flm-color-option').forEach(opt => {
      opt.addEventListener('click', () => {
        if (opt.classList.contains('flm-color-option-custom')) {
          selectColor(customColorBtn, customColorBtn.dataset.color);
          return;
        }
        selectColor(opt, opt.dataset.color);
      });
    });

    function onCustomColorChange() {
      const value = inlineColorInput.value;
      customColorBtn.dataset.color = value;
      customColorBtn.style.setProperty('--flm-custom-color', value);
      selectColor(customColorBtn, value);
    }

    inlineColorInput.addEventListener('input', onCustomColorChange);
    inlineColorInput.addEventListener('change', onCustomColorChange);


    function closeModal(invokeCancel = false) {
      overlay.remove();
      if (invokeCancel && typeof onCancel === 'function') {
        onCancel();
      }
    }

    overlay.querySelector('.cancel').addEventListener('click', () => {
      closeModal(true);
    });


    overlay.querySelector('.primary').addEventListener('click', () => {
      const newName = input.value.trim();
      if (newName) {
        const selectedParentId = parentSelect ? (parentSelect.value || null) : null;
        onSave(newName, selectedColor, selectedParentId);
        closeModal(false);
      } else {
        input.focus();
        input.style.borderColor = '#f44336';
      }
    });


    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal(true);
      }
    });


    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        overlay.querySelector('.primary').click();
      }
    });

    input.focus();
    input.select();
  }

  // ========================================

  // ========================================

  function updateNotebookCards() {
    function shortenLabel(text, max = 14) {
      const t = String(text || '').trim();
      if (t.length <= max) return t;
      return `${t.slice(0, Math.max(0, max - 1))}…`;
    }

    state.notebooks.forEach(notebook => {
      if (!notebook.element) return;
      let label = notebook.element.querySelector('.flm-group-label');

      if (notebook.manageable === false) {
        if (label) label.remove();
        return;
      }

      const assignedGroupId = state.assignments[notebook.id];
      const group = state.groups.find(g => g.id === assignedGroupId);

      if (!label) {
        label = document.createElement('div');
        label.className = 'flm-group-label';
        const pos = window.getComputedStyle(notebook.element).position;
        if (!pos || pos === 'static') {
          notebook.element.style.position = 'relative';
        }
        notebook.element.appendChild(label);
      } else if (label.tagName === 'BUTTON') {
        const replacement = document.createElement('div');
        replacement.className = 'flm-group-label';
        label.replaceWith(replacement);
        label = replacement;
      }

      if (group) {
        const parent = group.parentId ? state.groups.find((g) => g.id === group.parentId) : null;
        label.textContent = parent ? `${parent.name} | ${shortenLabel(group.name)}` : group.name;
        label.style.background = group.color;
      } else {
        label.textContent = 'No folder';
        label.style.background = '#7a7f87';
      }

      label.dataset.notebookId = notebook.id;
      if (!label.dataset.folderMenuBound) {
        label.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const id = label.dataset.notebookId;
          if (!id) return;
          openNotebookFolderMenu(id, label);
        });
        label.dataset.folderMenuBound = '1';
      }
    });
  }

  // ========================================

  // ========================================

  function updateStats() {
    const folderCount = document.getElementById('flm-folder-count');
    const notebookCount = document.getElementById('flm-notebook-count');
    const manageable = getManageableNotebooks();

    if (folderCount) folderCount.textContent = `Folders: ${state.groups.length}`;
    if (notebookCount) notebookCount.textContent = `Notebooks: ${manageable.length}`;
  }

  // ========================================

  // ========================================

  function showToast(message) {
    const existing = document.querySelector('.flm-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'flm-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('hiding');
      setTimeout(() => toast.remove(), 300);
    }, 2000);
  }

  // ========================================

  // ========================================

  async function init() {

    if (!isExtensionContextValid()) {
      log('Extension context invalidated, stopping initialization');
      return;
    }
    
    log('Initializing...');
    log('Current URL:', window.location.href);
    log('Pathname:', window.location.pathname);
    
    if (state.initialized) {
      log('Already initialized');
      return;
    }

    await loadState();
    

    const isNotebookPage = window.location.pathname.includes('/notebook/');
    log('Is notebook detail page:', isNotebookPage);
    
    if (isNotebookPage) {
      log('On notebook detail page, skipping sidebar');
      removeMainCategoryBar();
      return;
    }


    log('Waiting for content...');
    await waitForContent();
    log('Content found, proceeding...');
    
    detectNotebooks();
    refreshMainCategoryBar();
    
    if (state.notebooks.length > 0) {
      log('Creating sidebar...');
      createSidebar();
      updateNotebookCards();
      setupMainAreaDrag();
    } else {
      log('No notebooks found, retrying in 2 seconds...');
      setTimeout(() => {
        detectNotebooks();
        refreshMainCategoryBar();
        if (state.notebooks.length > 0) {
          createSidebar();
          updateNotebookCards();
          setupMainAreaDrag();
        }
      }, 2000);
    }

    state.initialized = true;


    let updateTimeout = null;
    const DEBOUNCE_DELAY = 2500;


    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }


    domObserver = new MutationObserver((mutations) => {

      if (!isExtensionContextValid()) {
        domObserver.disconnect();
        return;
      }
      

      const isNotebookPage = window.location.pathname.includes('/notebook/');
      if (isNotebookPage) {
        return;
      }
      
      let shouldUpdate = false;
      
      mutations.forEach(mutation => {
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          const isOrganizerElement = Array.from(mutation.addedNodes).some(node => 
            node.id && node.id.startsWith('flm-')
          );
          if (!isOrganizerElement) {
            shouldUpdate = true;
          }
        }
      });

      if (shouldUpdate) {

        if (updateTimeout) {
          clearTimeout(updateTimeout);
        }
        updateTimeout = setTimeout(() => {
          if (!isExtensionContextValid()) return;
          

          if (window.location.pathname.includes('/notebook/')) {
            log('On notebook detail page, skipping DOM update');
            return;
          }
          
          log('DOM changed, updating...');
          detectNotebooks();
          refreshMainCategoryBar();
          if (state.notebooks.length > 0) {
            updateGroupsList();
            updateNotebookCards();
            setupMainAreaDrag();
          }
        }, DEBOUNCE_DELAY);
      }
    });

    domObserver.observe(document.body, {
      childList: true,
      subtree: true
    });


    let lastUrl = location.href;
    

    if (urlObserver) {
      urlObserver.disconnect();
      urlObserver = null;
    }
    
    urlObserver = new MutationObserver(() => {

      if (!isExtensionContextValid()) {
        urlObserver.disconnect();
        return;
      }
      
      if (location.href !== lastUrl) {
        log('URL changed:', lastUrl, '->', location.href);
        lastUrl = location.href;
        state.initialized = false;
        

        if (domObserver) {
          domObserver.disconnect();
          domObserver = null;
        }
        
        const sidebar = document.getElementById('flm-sidebar');
        if (sidebar) sidebar.remove();
        removeMainCategoryBar();
        document.body.classList.remove('flm-organizer-active', 'flm-organizer-collapsed');
        
        setTimeout(init, 1000);
      }
    });
    urlObserver.observe(document, { subtree: true, childList: true });
  }

  async function waitForContent() {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 20;
      
      const check = () => {
        attempts++;
        log(`Checking for content (attempt ${attempts}/${maxAttempts})...`);
        

        const matRows = document.querySelectorAll('tr.mat-mdc-row:not(.mat-mdc-header-row)');

        const cards = document.querySelectorAll('.project-card, [class*="notebook-card"], mat-card');

        const jslogElements = document.querySelectorAll('[jslog*="track:generic_click"]');
        
        log('Found mat-mdc-row:', matRows.length);
        log('Found cards:', cards.length);
        log('Found jslog elements:', jslogElements.length);
        
        if (matRows.length > 0 || cards.length > 0 || jslogElements.length > 0) {
          resolve();
        } else if (attempts < maxAttempts) {
          setTimeout(check, 500);
        } else {
          log('Max attempts reached, proceeding anyway');
          resolve();
        }
      };
      check();
    });
  }


  log('Script loaded, starting initialization...');

  const handleSystemThemeChange = () => {
    refreshThemeFromSystem();
  };
  if (typeof systemThemeQuery.addEventListener === 'function') {
    systemThemeQuery.addEventListener('change', handleSystemThemeChange);
  } else if (typeof systemThemeQuery.addListener === 'function') {
    systemThemeQuery.addListener(handleSystemThemeChange);
  }
  

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'resetState') {
      log('Received reset message, clearing state...');

      state.notebooks = [];
      state.groups = [];
      state.favorites = [];
      state.assignments = {};
      state.expandedGroups = {};
      state.missingIdCounts = {};
      state.sidebarCollapsed = false;
      state.searchQuery = '';
      state.mainFilterGroupId = 'all';
      state.viewMode = 'custom';
      state.initialized = false;
      

      const sidebar = document.getElementById('flm-sidebar');
      if (sidebar) sidebar.remove();
      removeMainCategoryBar();
      document.body.classList.remove('flm-organizer-active', 'flm-organizer-collapsed');
      
      sendResponse({ success: true });
    } else if (message.action === 'refreshStats') {
      log('Received refresh message, re-detecting notebooks...');
      

      detectNotebooks();
      refreshMainCategoryBar();
      

      updateGroupsList();
      updateNotebookCards();
      

      sendResponse({
        success: true,
        stats: {
          notebooks: state.notebooks.length,
          groups: state.groups.length,
          favorites: state.favorites.length,
          assigned: Object.keys(state.assignments).length
        }
      });
    } else if (message.action === 'getNotebookIds') {

      log('Received getNotebookIds request');
      sendResponse({
        success: true,
        notebookIds: state.notebooks.map(n => n.id),

        notebooks: state.notebooks.map(n => ({
          id: n.id,
          title: n.title
        }))
      });
    } else if (message.action === 'reloadState') {

      log('Received reloadState request');
      loadState().then(() => {
        updateGroupsList(true);
        sendResponse({ success: true });
      });
      return true;
    }
    return true;
  });
  

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes[STORAGE_KEY]) return;
    

    if (isSavingFromContentScript) {
      return;
    }
    

    const storageChange = changes[STORAGE_KEY];
    const newValue = storageChange.newValue;
    if (newValue) {
      state.groups = newValue.groups || [];
      state.favorites = [];
      state.assignments = newValue.assignments || {};
      state.expandedGroups = newValue.expandedGroups || {};
      state.sidebarWidth = newValue.sidebarWidth || 248;
      state.viewMode = 'custom';
      state.theme = 'auto';
      state.mainFilterGroupId = newValue.mainFilterGroupId || 'all';
      normalizeGroupHierarchy();
      

      state.importedAt = Date.now();
      

      state.missingIdCounts = {};
      

      updateGroupsList(true);
      refreshMainCategoryBar();
      

      const sidebar = document.getElementById('flm-sidebar');
      if (sidebar) {
        applyTheme(sidebar);
      }
    }
  });
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
