<p align="center">
  <img src="icons/icon128.png" alt="FolderLM" width="80" />
</p>

<h1 align="center">FolderLM</h1>

<p align="center">
  <strong>Workspace organizer for Google NotebookLM</strong><br/>
  Nested folders · Drag & drop · Search · Slide prompts
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Chrome-4285F4?logo=googlechrome&logoColor=white" alt="Chrome" />
  <img src="https://img.shields.io/badge/manifest-v3-34A853" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/version-1.1.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="Zero Dependencies" />
</p>

<p align="center">
  <a href="README.zh-CN.md">中文文档</a>
</p>

---

## Overview

**FolderLM** is a Chrome extension that adds a powerful workspace management layer to [Google NotebookLM](https://notebooklm.google.com). NotebookLM doesn't natively support folders or grouping — FolderLM fills that gap with a clean, integrated sidebar UI.

## Features

- **Nested Folder Organization** — Create hierarchical groups to categorize your notebooks
- **Drag & Drop** — Intuitively move notebooks between folders
- **Search & Filter** — Quickly find notebooks across your entire workspace
- **Favorites** — Pin frequently used notebooks for instant access
- **Resizable Sidebar** — Adjust the workspace panel to your preferred width
- **Slide Prompt Generator** — Generate presentation prompts with customizable color palettes, fonts, and tones
- **Data Portability** — Export and import your workspace configuration
- **Theme Support** — Automatic light/dark mode that syncs with your system preference

## Architecture

```
folderlm/
├── manifest.json        # Extension configuration (Manifest V3)
├── background.js        # Service worker for side panel management
├── content.js           # Core logic — injected sidebar & workspace engine
├── styles.css           # Injected styles with CSS variable theming
├── popup.html / .js     # Extension popup — stats, settings, slide prompts
├── sidepanel.html / .js # Chrome side panel interface
└── icons/               # Extension icons (SVG source + PNG exports)
```

| Layer | Role |
|-------|------|
| **Content Script** | Injects the sidebar into NotebookLM, handles notebook detection, drag-and-drop, and state persistence |
| **Popup** | Quick-access dashboard with workspace stats and the slide prompt generator |
| **Side Panel** | Full-featured workspace management interface |
| **Background** | Minimal service worker that manages side panel lifecycle |

## Tech Stack

- **Vanilla JavaScript** (ES6+) — zero dependencies, no build step
- **Chrome Extension Manifest V3**
- **Chrome Storage API** for persistent state
- **CSS Custom Properties** for theming

## Installation

### From Source (Developer Mode)

1. Clone this repository:
   ```bash
   git clone https://github.com/agentenatalie/folderlm.git
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `folderlm` directory
5. Navigate to [notebooklm.google.com](https://notebooklm.google.com) — the sidebar will appear automatically

## Usage

1. **Create folders** — Click the `+` button in the sidebar to create a new group
2. **Organize** — Drag notebooks from the list into your folders
3. **Search** — Use the search bar to filter notebooks by name
4. **Favorite** — Star notebooks you access frequently
5. **Slide prompts** — Open the popup to generate AI presentation prompts with custom styling

## License

[MIT](LICENSE)

---

<p align="center">
  <sub>Built for anyone who has too many NotebookLM notebooks.</sub>
</p>
