<p align="center">
  <img src="icons/icon128.png" alt="FolderLM" width="80" />
</p>

<h1 align="center">FolderLM</h1>

<p align="center">
  <strong>Google NotebookLM 工作区管理器</strong><br/>
  嵌套文件夹 · 拖拽分组 · 搜索筛选 · 幻灯片提示词
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Chrome-4285F4?logo=googlechrome&logoColor=white" alt="Chrome" />
  <img src="https://img.shields.io/badge/manifest-v3-34A853" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/version-1.1.0-blue" alt="Version" />
  <img src="https://img.shields.io/badge/dependencies-zero-brightgreen" alt="Zero Dependencies" />
</p>

<p align="center">
  <a href="README.md">English</a>
</p>

---

## 概述

**FolderLM** 是一款 Chrome 扩展，为 [Google NotebookLM](https://notebooklm.google.com) 添加工作区管理功能。NotebookLM 原生不支持文件夹或分组管理 ── FolderLM 通过一个简洁的侧边栏 UI 填补了这一空白。

## 功能特性

- **嵌套文件夹** ── 创建多级分组，分类管理你的笔记本
- **拖拽排序** ── 直接拖动笔记本到目标文件夹
- **搜索与筛选** ── 在整个工作区中快速定位笔记本
- **收藏夹** ── 置顶常用笔记本，一键访问
- **可调节侧边栏** ── 自由拖拽调整面板宽度
- **幻灯片提示词生成器** ── 自定义配色方案、字体和风格，生成演示文稿提示词
- **数据导入/导出** ── 导出和导入工作区配置，随时备份迁移
- **主题跟随系统** ── 自动适配系统的明/暗模式

## 项目结构

```
folderlm/
├── manifest.json        # 扩展配置（Manifest V3）
├── background.js        # Service Worker，管理侧面板生命周期
├── content.js           # 核心逻辑 ── 注入侧边栏与工作区引擎
├── styles.css           # 注入样式，基于 CSS 变量的主题系统
├── popup.html / .js     # 扩展弹窗 ── 统计数据、设置、幻灯片提示词
├── sidepanel.html / .js # Chrome 侧面板界面
└── icons/               # 扩展图标（SVG 源文件 + PNG 导出）
```

| 模块 | 职责 |
|------|------|
| **Content Script** | 向 NotebookLM 页面注入侧边栏，处理笔记本检测、拖拽排序与状态持久化 |
| **Popup** | 快捷面板：工作区统计、幻灯片提示词生成器 |
| **Side Panel** | 完整的工作区管理界面 |
| **Background** | 轻量 Service Worker，管理侧面板生命周期 |

## 技术栈

- **原生 JavaScript**（ES6+）── 零依赖，无需构建
- **Chrome Extension Manifest V3**
- **Chrome Storage API** 实现状态持久化
- **CSS Custom Properties** 实现主题切换

## 安装

### 从源码安装（开发者模式）

1. 克隆仓库：
   ```bash
   git clone https://github.com/agentenatalie/folderlm.git
   ```
2. 打开 Chrome，进入 `chrome://extensions/`
3. 开启右上角的 **开发者模式**
4. 点击 **加载已解压的扩展程序**，选择 `folderlm` 目录
5. 访问 [notebooklm.google.com](https://notebooklm.google.com) ── 侧边栏会自动出现

## 使用方法

1. **创建文件夹** ── 点击侧边栏中的 `+` 按钮新建分组
2. **整理笔记本** ── 将笔记本拖拽到对应的文件夹中
3. **搜索** ── 使用搜索栏按名称筛选笔记本
4. **收藏** ── 为常用笔记本添加星标
5. **幻灯片提示词** ── 打开弹窗，生成自定义风格的 AI 演示文稿提示词

## 许可证

[MIT](LICENSE)

---

<p align="center">
  <sub>为笔记本太多的你而生。</sub>
</p>
