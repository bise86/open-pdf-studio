import { createSignal, onMount, onCleanup, Show, For } from 'solid-js';
import { useTranslation } from '../i18n/useTranslation.js';
import { state, getActiveDocument, clearSelection } from '../core/state.js';
import { isTauri, isMobile, extractFileName } from '../core/platform.js';
import { loadPDF, loadPDFIfNeeded } from '../pdf/loader.js';
import { fitWidth, fitPage, goToPage, rotatePage, setZoom } from '../pdf/renderer.js';
import { createTab } from '../ui/chrome/tabs.js';
import { initDomElements } from '../ui/dom-elements.js';
import { applyTheme, savePreferences } from '../core/preferences.js';
import { getSelectedText } from '../text/text-selection.js';
import { createTextMarkupAnnotation } from '../text/text-markup.js';
import { setTool } from '../tools/manager.js';
import { openDialog, showMessage } from './stores/dialogStore.js';
import { undo, redo, recordBulkDelete } from '../core/undo-manager.js';
import {
  copyPage, cutPage, pastePage, insertPagesFromFile,
  deletePages, reorderPages, replacePages, mergeFiles,
} from '../pdf/page-manager.js';
import { pasteImageFromBlob } from '../annotations/clipboard.js';
import { addBookmark } from '../ui/panels/bookmarks.js';
import { initPinchZoom, initDoubleTap, initSwipeNavigation } from '../mobile/touch-gestures.js';
import { getRecentFiles, addRecentFile, clearRecentFiles } from '../mobile/recent-files.js';
import { LANGUAGES } from '../i18n/config.js';
import { changeLanguage } from '../i18n/useTranslation.js';
import LoadingOverlay from './components/LoadingOverlay.jsx';
import DialogHost from './components/DialogHost.jsx';
import PropertiesPanel from './components/properties-panel/PropertiesPanel.jsx';
import FormFieldsBar from './components/FormFieldsBar.jsx';
import HandtekeningBar from './components/HandtekeningBar.jsx';
import PdfABar from './components/PdfABar.jsx';

export default function MobileApp() {
  const { t } = useTranslation('common');
  const { t: tRibbon } = useTranslation('ribbon');
  const { t: tProperties } = useTranslation('properties');
  const { t: tDialogs } = useTranslation('dialogs');
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [toolsOpen, setToolsOpen] = createSignal(false);
  const [pagesOpen, setPagesOpen] = createSignal(false);
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [propertiesOpen, setPropertiesOpen] = createSignal(false);
  const [darkMode, setDarkMode] = createSignal(false);
  const [fullscreen, setFullscreen] = createSignal(false);
  const [barsVisible, setBarsVisible] = createSignal(false);
  const [toolbarCollapsed, setToolbarCollapsed] = createSignal(false);
  const [gotoOpen, setGotoOpen] = createSignal(false);
  const [gotoValue, setGotoValue] = createSignal('');
  const [recentFiles, setRecentFiles] = createSignal([]);
  const [copyFabVisible, setCopyFabVisible] = createSignal(false);
  const [prefsOpen, setPrefsOpen] = createSignal(false);
  const [historyBusy, setHistoryBusy] = createSignal(false);
  let fileInputRef;
  let insertPdfInputRef;
  let replacePdfInputRef;
  let mergePdfInputRef;
  let imageInputRef;
  let mainRef;
  let barsTimer = null;
  let darkThemeName = 'dark';

  const hasDocument = () => state.documents && state.documents.length > 0;
  const currentDoc = () => hasDocument() ? state.documents[state.activeDocumentIndex] : null;
  const undoEnabled = () => !!currentDoc()?.pdfDoc && !historyBusy() && (currentDoc()?.undoStack?.length || 0) > 0;
  const redoEnabled = () => !!currentDoc()?.pdfDoc && !historyBusy() && (currentDoc()?.redoStack?.length || 0) > 0;
  const totalPages = () => state.documents[state.activeDocumentIndex]?.pdfDoc?.numPages || 0;
  const fileName = () => {
    const doc = currentDoc();
    if (!doc || !doc.filePath) return 'Open PDF Studio';
    const parts = doc.filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  };

  onMount(() => {
    // Read initial theme
    const currentTheme = document.documentElement.getAttribute('data-theme');
    // The default and custom themes are dark palettes too. The previous
    // `=== 'dark'` check treated the default theme as light, so the first tap
    // changed the theme in the opposite direction and the icon needed a
    // second tap to catch up.
    if (currentTheme && currentTheme !== 'light') darkThemeName = currentTheme;
    setDarkMode(currentTheme !== 'light');

    // Load recent files
    setRecentFiles(getRecentFiles());

    // Init touch gestures on main container
    if (mainRef) {
      initPinchZoom(mainRef);
      initDoubleTap(mainRef);
      initSwipeNavigation(mainRef);
    }

    // Listen for text selection changes to show/hide copy FAB
    const selectionHandler = () => {
      const text = getSelectedText();
      setCopyFabVisible(!!text);
    };
    document.addEventListener('selectionchange', selectionHandler);

    onCleanup(() => {
      document.removeEventListener('selectionchange', selectionHandler);
      if (barsTimer) clearTimeout(barsTimer);
    });
  });

  // --- File operations ---

  // Android's native dialog returns a content:// URI. That URI is not a stable
  // filesystem path for the Rust renderer, and older Android WebViews can also
  // reject it from the Tauri fs plugin. The HTML picker gives us the bytes
  // directly, so PDF.js can render the document without depending on URI
  // resolution. Desktop keeps the native dialog and filesystem path flow.

  async function handleOpen() {
    setDrawerOpen(false);

    if (isMobile()) {
      fileInputRef?.click();
      return;
    }

    // Desktop: use the native dialog and filesystem path.
    if (isTauri() && window.__TAURI__?.dialog) {
      try {
        const path = await window.__TAURI__.dialog.open({
          multiple: false,
          filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
        });
        if (path) {
          const { index } = createTab(path);
          await new Promise(r => setTimeout(r, 0));
          initDomElements();
          // Picking a file that is already open only shows it: a reload
          // would drop its unsaved annotations and undo history.
          if (await loadPDFIfNeeded(path, index)) await fitPage();
          addRecentFile(path, extractFileName(path));
          setRecentFiles(getRecentFiles());
          return; // Success — done
        }
        // path is null = user cancelled, don't fall through
        return;
      } catch (e) {
        console.warn('Tauri dialog failed, falling back to HTML file input:', e);
      }
    }

    // Attempt 2: HTML <input type="file"> (guaranteed fallback)
    fileInputRef?.click();
  }

  async function handleFileInput(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const data = new Uint8Array(arrayBuffer);
      const { index } = createTab(file.name);
      await new Promise(r => setTimeout(r, 0));
      initDomElements();
      // Re-apply the active tool after the mobile canvas is mounted so its
      // pointer/touch behavior is configured before the first edit gesture.
      setTool(state.currentTool);
      await loadPDF(file.name, index, data);
      await fitPage();
      addRecentFile(file.name, file.name);
      setRecentFiles(getRecentFiles());
    } catch (err) {
      alert('Failed to load PDF: ' + (err.message || err));
      console.warn('Failed to load PDF:', err);
    }
    e.target.value = '';
  }

  function chooseTool(tool) {
    setTool(tool);
    setToolsOpen(false);
    setDrawerOpen(false);
    setPagesOpen(false);
    setAdvancedOpen(false);
    setPropertiesOpen(false);
  }

  // Android has no physical Delete key. Keep the same undoable delete path as
  // the desktop keyboard handler so selected text boxes, images and other
  // annotations can be removed directly from the mobile editing menu.
  async function handleDeleteSelected() {
    const doc = currentDoc();
    const selected = [...(doc?.selectedAnnotations || [])].filter(annotation => !annotation.locked);
    if (!doc || selected.length === 0) return;
    const message = `${t('delete')}?`;
    if (!window.confirm(message)) return;
    recordBulkDelete(selected);
    const deleted = new Set(selected);
    doc.annotations = doc.annotations.filter(annotation => !deleted.has(annotation));
    clearSelection();
    setToolsOpen(false);
    setDrawerOpen(false);
    setPropertiesOpen(false);
    import('../annotations/rendering.js').then(({ redrawAnnotations, redrawContinuous }) => {
      if (doc.viewMode === 'continuous') redrawContinuous();
      else redrawAnnotations();
    });
  }

  function applySelectionMarkup(type, color, opacity, fallbackTool) {
    if (getSelectedText()) {
      createTextMarkupAnnotation(type, color, opacity);
      setToolsOpen(false);
      return;
    }
    chooseTool(fallbackTool);
  }

  function currentPageNumber() {
    return getActiveDocument()?.currentPage || 1;
  }

  function currentPageList() {
    return Array.from({ length: totalPages() }, (_, i) => i + 1);
  }

  async function handleInsertPdfInput(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    setDrawerOpen(false);
    setPagesOpen(false);
    if (!file || !hasDocument()) return;
    try {
      await insertPagesFromFile(currentPageNumber(), 'after', null, {
        sourceBytes: new Uint8Array(await file.arrayBuffer()),
        sourceName: file.name,
      });
    } catch (err) {
      console.warn('Failed to insert PDF pages:', err);
      alert(`Failed to insert pages: ${err.message || err}`);
    }
  }

  async function handleReplacePdfInput(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    setDrawerOpen(false);
    setPagesOpen(false);
    if (!file || !hasDocument()) return;
    try {
      await replacePages(currentPageNumber(), new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (err) {
      console.warn('Failed to replace page:', err);
      alert(`Failed to replace page: ${err.message || err}`);
    }
  }

  async function handleMergePdfInput(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    setDrawerOpen(false);
    setPagesOpen(false);
    if (!files.length || !hasDocument()) return;
    try {
      const bytes = [];
      for (const file of files) bytes.push(new Uint8Array(await file.arrayBuffer()));
      await mergeFiles(bytes, 'after');
    } catch (err) {
      console.warn('Failed to merge PDFs:', err);
      alert(`Failed to merge PDFs: ${err.message || err}`);
    }
  }

  async function handleImageInput(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !hasDocument()) return;
    try {
      await pasteImageFromBlob(file);
    } catch (err) {
      console.warn('Failed to insert image:', err);
      alert(`Failed to insert image: ${err.message || err}`);
    }
  }

  async function handleDuplicatePage() {
    if (!hasDocument()) return;
    const page = currentPageNumber();
    await copyPage(page);
    await pastePage(page);
  }

  async function handleMovePage(delta) {
    if (!hasDocument()) return;
    const page = currentPageNumber();
    const target = page + delta;
    if (target < 1 || target > totalPages()) return;
    const order = currentPageList();
    [order[page - 1], order[target - 1]] = [order[target - 1], order[page - 1]];
    await reorderPages(order);
  }

  function openPageDialog(name, data = {}) {
    setPagesOpen(false);
    openDialog(name, data);
  }

  function openAdvancedDialog(name, data = {}) {
    setAdvancedOpen(false);
    openDialog(name, {
      currentPage: currentPageNumber(),
      totalPages: totalPages(),
      ...data,
    });
  }

  async function handleOpenRecent(recent) {
    setDrawerOpen(false);
    // On mobile, content:// URI permissions expire after app restart, and
    // HTML file input paths are just display names — neither can be reopened.
    // Prompt the user to re-pick the file.
    alert('Please use the Open button to reopen this file. Android does not allow apps to reopen files by path.');
  }

  function handleClearRecents() {
    clearRecentFiles();
    setRecentFiles([]);
  }

  // --- Navigation ---

  const isRTL = () => document.documentElement.getAttribute('dir') === 'rtl';

  function handlePrevPage() {
    if (!hasDocument()) return;
    const doc = getActiveDocument();
    if (doc && doc.currentPage > 1) {
      goToPage(doc.currentPage - 1);
    }
  }

  function handleNextPage() {
    if (!hasDocument()) return;
    const doc = getActiveDocument();
    if (doc && doc.currentPage < totalPages()) {
      goToPage(doc.currentPage + 1);
    }
  }

  function handleZoomIn() {
    if (!hasDocument()) return;
    const doc = getActiveDocument();
    const currentScale = doc?.scale || 1.5;
    const newScale = Math.min(5.0, currentScale * 1.25);
    setZoom(newScale);
  }

  function handleZoomOut() {
    if (!hasDocument()) return;
    const doc = getActiveDocument();
    const currentScale = doc?.scale || 1.5;
    const newScale = Math.max(0.25, currentScale / 1.25);
    setZoom(newScale);
  }

  function handleSave() {
    setDrawerOpen(false);
    window.dispatchEvent(new CustomEvent('save-document'));
  }

  function handleSaveAs() {
    setDrawerOpen(false);
    window.dispatchEvent(new CustomEvent('save-document-as'));
  }

  function handlePrint() {
    setDrawerOpen(false);
    window.dispatchEvent(new CustomEvent('print-document'));
  }

  async function handleHistoryAction(action) {
    if (action === 'undo' ? !undoEnabled() : !redoEnabled()) return;
    // Page changes restore the PDF asynchronously. Keep both entry points
    // disabled until the current operation finishes.
    setHistoryBusy(true);
    setDrawerOpen(false);
    setPagesOpen(false);
    try {
      await (action === 'undo' ? undo() : redo());
    } catch (error) {
      console.error(`Failed to ${action}:`, error);
      showMessage(`${t(action)}: ${error?.message || String(error)}`);
    } finally {
      setHistoryBusy(false);
    }
  }

  // --- Dark mode toggle ---

  function handleToggleDarkMode() {
    const newMode = !darkMode();
    setDarkMode(newMode);
    if (!newMode) {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      if (currentTheme && currentTheme !== 'light') darkThemeName = currentTheme;
    }
    state.preferences.theme = newMode ? darkThemeName : 'light';
    savePreferences();
  }

  // --- Go-to-page ---

  function handleOpenGoto() {
    const doc = getActiveDocument();
    setGotoValue(String(doc ? doc.currentPage : 1));
    setGotoOpen(true);
  }

  function handleGotoSubmit() {
    const num = parseInt(gotoValue(), 10);
    if (!isNaN(num)) {
      const clamped = Math.max(1, Math.min(num, totalPages()));
      goToPage(clamped);
    }
    setGotoOpen(false);
  }

  function handleGotoKeyDown(e) {
    if (e.key === 'Enter') {
      handleGotoSubmit();
    } else if (e.key === 'Escape') {
      setGotoOpen(false);
    }
  }

  // --- Page rotation ---

  function handleRotate() {
    rotatePage(90);
  }

  // --- Fullscreen ---

  function handleToggleFullscreen() {
    const newState = !fullscreen();
    setFullscreen(newState);
    setBarsVisible(false);

    if (newState) {
      try {
        document.documentElement.requestFullscreen?.();
      } catch (e) { /* ignore */ }
    } else {
      try {
        if (document.fullscreenElement) {
          document.exitFullscreen?.();
        }
      } catch (e) { /* ignore */ }
    }
  }

  function handleFullscreenTap() {
    if (!fullscreen()) return;

    if (barsVisible()) {
      setBarsVisible(false);
      if (barsTimer) clearTimeout(barsTimer);
    } else {
      setBarsVisible(true);
      if (barsTimer) clearTimeout(barsTimer);
      barsTimer = setTimeout(() => {
        setBarsVisible(false);
      }, 3000);
    }
  }

  // --- Text copy ---

  async function handleCopyText() {
    const text = getSelectedText();
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
        setCopyFabVisible(false);
        window.getSelection()?.removeAllRanges();
      } catch (e) {
        console.warn('Failed to copy text:', e);
      }
    }
  }

  // --- Collapsible toolbar ---

  function handleToggleCollapse() {
    setToolbarCollapsed(!toolbarCollapsed());
  }

  return (
    <div class="mobile-app" classList={{ fullscreen: fullscreen(), 'bars-visible': barsVisible() }}>
      {/* Hidden file input for browser fallback */}
      <input
        type="file"
        accept=".pdf,application/pdf"
        style="display:none"
        ref={fileInputRef}
        onChange={handleFileInput}
      />
      <input type="file" accept=".pdf,application/pdf" style="display:none" ref={insertPdfInputRef} onChange={handleInsertPdfInput} />
      <input type="file" accept=".pdf,application/pdf" style="display:none" ref={replacePdfInputRef} onChange={handleReplacePdfInput} />
      <input type="file" accept=".pdf,application/pdf" multiple style="display:none" ref={mergePdfInputRef} onChange={handleMergePdfInput} />
      <input type="file" accept="image/*" style="display:none" ref={imageInputRef} onChange={handleImageInput} />

      {/* Top bar */}
      <div class="mobile-topbar">
        <button class="mobile-topbar-btn" onClick={() => setDrawerOpen(true)} aria-label="Menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <span class="mobile-topbar-title">{fileName()}</span>
        <Show when={hasDocument()}>
          <button class="mobile-topbar-btn" onClick={() => handleHistoryAction('undo')}
            disabled={!undoEnabled()} title={t('undo')} aria-label={t('undo')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7h11a7 7 0 0 1 0 14h-3" />
              <path d="M7 3 3 7l4 4" />
            </svg>
          </button>
          <button class="mobile-topbar-btn" onClick={() => handleHistoryAction('redo')}
            disabled={!redoEnabled()} title={t('redo')} aria-label={t('redo')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 7H10a7 7 0 0 0 0 14h3" />
              <path d="m17 3 4 4-4 4" />
            </svg>
          </button>
        </Show>
        <button class="mobile-topbar-btn" onClick={handleToggleDarkMode} aria-label="Toggle dark mode">
          <Show when={darkMode()} fallback={
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
            </svg>
          }>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          </Show>
        </button>
        <button class="mobile-topbar-btn" onClick={handleOpen} aria-label="Open file">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
          </svg>
        </button>
      </div>

      {/* Main PDF view */}
      <FormFieldsBar />
      <PdfABar />
      <HandtekeningBar />
      <div class="mobile-main" ref={mainRef} onClick={handleFullscreenTap}>
        <Show when={!hasDocument()}>
          <div class="mobile-placeholder">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" width="64" height="64">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
            <p>Open a PDF file to get started</p>
            <button class="mobile-open-btn" onClick={handleOpen}>
              {t('open')} PDF
            </button>
          </div>
        </Show>

        <div id="placeholder" style="display:none"></div>
        <div id="pdf-container" class="mobile-pdf-container" classList={{ visible: hasDocument() }}>
          <div id="canvas-wrapper">
            <div id="canvas-container" class="single-page-container">
              <canvas id="pdf-canvas"></canvas>
              <canvas id="text-highlight-canvas"></canvas>
              <canvas id="annotation-canvas"></canvas>
            </div>
            <div id="continuous-container" class="continuous-container"></div>
          </div>
        </div>
      </div>

      {/* Bottom toolbar */}
      <Show when={hasDocument()}>
        <div class="mobile-bottombar" classList={{ collapsed: toolbarCollapsed() }}>
          {/* Collapse/expand handle */}
          <button class="mobile-toolbar-collapse-handle" onClick={handleToggleCollapse} aria-label={toolbarCollapsed() ? 'Expand toolbar' : 'Collapse toolbar'}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <Show when={toolbarCollapsed()} fallback={
                <polyline points="6 9 12 15 18 9" />
              }>
                <polyline points="6 15 12 9 18 15" />
              </Show>
            </svg>
          </button>

          <div class="mobile-toolbar-content">
            <button class="mobile-toolbar-btn" onClick={isRTL() ? handleNextPage : handlePrevPage} disabled={isRTL() ? (state.documents[state.activeDocumentIndex]?.currentPage || 1) >= totalPages() : (state.documents[state.activeDocumentIndex]?.currentPage || 1) <= 1} aria-label="Previous page">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>

            <button class="mobile-page-info" onClick={handleOpenGoto} aria-label="Go to page">
              {state.documents[state.activeDocumentIndex]?.currentPage || 1} / {totalPages()}
            </button>

            <button class="mobile-toolbar-btn" onClick={isRTL() ? handlePrevPage : handleNextPage} disabled={isRTL() ? (state.documents[state.activeDocumentIndex]?.currentPage || 1) <= 1 : (state.documents[state.activeDocumentIndex]?.currentPage || 1) >= totalPages()} aria-label="Next page">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>

            <div class="mobile-toolbar-separator"></div>

            <button class="mobile-toolbar-btn" onClick={handleZoomOut} aria-label="Zoom out">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>

            <button class="mobile-toolbar-btn" onClick={handleZoomIn} aria-label="Zoom in">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="11" y1="8" x2="11" y2="14" />
                <line x1="8" y1="11" x2="14" y2="11" />
              </svg>
            </button>

            <div class="mobile-toolbar-separator"></div>

            {/* Rotate button */}
            <button class="mobile-toolbar-btn" onClick={handleRotate} aria-label="Rotate page">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 102.13-9.36L1 10" />
              </svg>
            </button>

            {/* Fullscreen button */}
            <button class="mobile-toolbar-btn" onClick={handleToggleFullscreen} aria-label={fullscreen() ? 'Exit fullscreen' : 'Fullscreen'}>
              <Show when={fullscreen()} fallback={
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              }>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </Show>
            </button>

            <div class="mobile-toolbar-separator"></div>

            <button class="mobile-toolbar-btn" onClick={() => setToolsOpen(!toolsOpen())} aria-label="Annotation tools">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
              </svg>
            </button>
          </div>
        </div>
      </Show>

      {/* Annotation tools dropdown */}
      <Show when={toolsOpen()}>
        <div class="mobile-tools-overlay" onClick={() => setToolsOpen(false)}>
          <div class="mobile-tools-menu" onClick={(e) => e.stopPropagation()}>
            <button class="mobile-tools-item" onClick={() => applySelectionMarkup('textHighlight', '#FFFF00', 0.3, 'highlight')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="10" width="18" height="6" rx="1" /></svg>
              <span>{tRibbon('comment.highlight')}</span>
            </button>
            <button class="mobile-tools-item" onClick={() => applySelectionMarkup('textUnderline', '#0000FF', 1.0, 'editText')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v7a6 6 0 006 6 6 6 0 006-6V3" /><line x1="4" y1="21" x2="20" y2="21" /></svg>
              <span>{tProperties('textFormat.underline', 'Underline')}</span>
            </button>
            <button class="mobile-tools-item" onClick={() => applySelectionMarkup('textStrikethrough', '#FF0000', 1.0, 'editText')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="12" x2="20" y2="12" /><path d="M6 20V4" /></svg>
              <span>{tProperties('textFormat.strikethrough', 'Strikethrough')}</span>
            </button>
            <button class="mobile-tools-item" onClick={() => chooseTool('draw')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" /></svg>
              <span>{tRibbon('comment.freehand')}</span>
            </button>
            <button class="mobile-tools-item" onClick={() => chooseTool('textbox')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>
              <span>{tRibbon('comment.textBox', 'Text')}</span>
            </button>
            <button class="mobile-tools-item" onClick={() => chooseTool('select')}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3h14" /><path d="M5 21h14" /><path d="M12 3v18" /><path d="M8 7l4-4 4 4" /><path d="M8 17l4 4 4-4" /></svg>
              <span>{tRibbon('home.selectText')}</span>
            </button>
            <button class="mobile-tools-item" onClick={() => chooseTool('editText')}><span>{tRibbon('home.editText')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('comment')}><span>{tRibbon('comment.note')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('callout')}><span>{tRibbon('comment.callout')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('stamp')}><span>{tRibbon('comment.stamp')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('signature')}><span>{tRibbon('comment.signature')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('redaction')}><span>{tRibbon('comment.redact')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('box')}><span>{tRibbon('comment.rectangle')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('circle')}><span>{tRibbon('comment.ellipse')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('line')}><span>{tRibbon('comment.line')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('arrow')}><span>{tRibbon('comment.arrow')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('polygon')}><span>{tRibbon('comment.polygon')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('polyline')}><span>{tRibbon('comment.polyline')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('measureDistance')}><span>{tRibbon('measure.measureDistance')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('measureArea')}><span>{tRibbon('measure.measureArea')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('measureAngle')}><span>{tRibbon('measure.measureAngle')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('measurePerimeter')}><span>{tRibbon('measure.measurePerimeter')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('eraser')}><span>{tRibbon('drawing.eraser', 'Eraser')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('removeImage')}><span>{tRibbon('drawing.removeImage', 'Remove embedded image')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('mask')}><span>{tRibbon('drawing.whiteout', 'Whiteout')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('ellipse')}><span>{tRibbon('comment.ellipse')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('cloud')}><span>{tRibbon('comment.cloud')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('arc')}><span>{tRibbon('drawing.arc', 'Arc')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('spline')}><span>{tRibbon('comment.spline')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('cloudPolyline')}><span>{tRibbon('comment.cloudPolyline')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('scaleBar')}><span>{tRibbon('measure.scaleBar')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('viewport')}><span>{tRibbon('measure.viewport')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('vectorSnippet')}><span>{tRibbon('drawing.vectorSnippet')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('trim')}><span>{tRibbon('drawing.trim', 'Trim')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('extend')}><span>{tRibbon('drawing.extend', 'Extend')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('array')}><span>{tRibbon('drawing.array', 'Array')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('split')}><span>{tRibbon('drawing.split', 'Split')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('break')}><span>{tRibbon('drawing.break', 'Break')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('lengthen')}><span>{tRibbon('drawing.lengthen', 'Lengthen')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('radius')}><span>{tRibbon('drawing.radius', 'Radius')}</span></button>
            <button class="mobile-tools-item" onClick={() => chooseTool('diameter')}><span>{tRibbon('drawing.diameter', 'Diameter')}</span></button>
            <button class="mobile-tools-item" onClick={() => imageInputRef?.click()}><span>{tRibbon('drawing.insertImage', 'Insert image')}</span></button>
            <Show when={(currentDoc()?.selectedAnnotations || []).length > 0}>
              <button class="mobile-tools-item" onClick={() => { setToolsOpen(false); setPropertiesOpen(true); }}>
                <span>{tRibbon('comment.properties')}</span>
              </button>
              <button class="mobile-tools-item mobile-tools-danger" onClick={handleDeleteSelected}>
                <span>{t('delete')} {tRibbon('comment.properties', 'selected')}</span>
              </button>
            </Show>
          </div>
        </div>
      </Show>

      {/* Go-to-page dialog */}
      <Show when={gotoOpen()}>
        <div class="mobile-goto-overlay" onClick={() => setGotoOpen(false)}>
          <div class="mobile-goto-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>{tRibbon('home.navigate')} / {tRibbon('home.page', 'Page')}</h3>
            <input
              type="number"
              min="1"
              max={totalPages()}
              value={gotoValue()}
              onInput={(e) => setGotoValue(e.target.value)}
              onKeyDown={handleGotoKeyDown}
              autofocus
            />
            <div class="mobile-goto-buttons">
              <button onClick={() => setGotoOpen(false)}>{t('cancel')}</button>
              <button class="primary" onClick={handleGotoSubmit}>{t('ok')}</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Copy text FAB */}
      <Show when={copyFabVisible() && hasDocument()}>
        <button class="mobile-copy-fab" onClick={handleCopyText}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="1" />
            <path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1" />
          </svg>
          Copy
        </button>
      </Show>

      {/* Slide-out drawer */}
      <div class="mobile-drawer-overlay" classList={{ open: drawerOpen() }} onClick={() => setDrawerOpen(false)}>
        <div class="mobile-drawer" classList={{ open: drawerOpen() }} onClick={(e) => e.stopPropagation()}>
          <div class="mobile-drawer-header">
            <span>Open PDF Studio</span>
            <button class="mobile-drawer-close" onClick={() => setDrawerOpen(false)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div class="mobile-drawer-items">
            <button class="mobile-drawer-item" onClick={handleOpen}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
              </svg>
              <span>{t('open')}</span>
            </button>
            <Show when={hasDocument()}>
              <button class="mobile-drawer-item" onClick={handleSave}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                <span>{t('save')}</span>
              </button>
              <button class="mobile-drawer-item" onClick={handleSaveAs}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
                  <polyline points="17 21 17 13 7 13 7 21" />
                  <polyline points="7 3 7 8 15 8" />
                </svg>
                <span>{t('saveAs')}</span>
              </button>
              <button class="mobile-drawer-item" onClick={handlePrint}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 6 2 18 2 18 9" />
                  <path d="M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2" />
                  <rect x="6" y="14" width="12" height="8" />
                </svg>
                <span>{t('print')}</span>
              </button>
            </Show>
            <Show when={hasDocument()}>
              <div class="mobile-drawer-section-label">{tRibbon('organize.pages')}</div>
              <button class="mobile-drawer-item" onClick={() => setPagesOpen(!pagesOpen())}><span>{tRibbon('organize.pages')}</span></button>
              <Show when={pagesOpen()}>
                <div class="mobile-drawer-submenu">
                  <button class="mobile-drawer-item" onClick={() => insertPdfInputRef?.click()}>{tRibbon('organize.insertPage')} PDF</button>
                  <button class="mobile-drawer-item" onClick={() => openPageDialog('insert-page')}>{tRibbon('organize.insertPage')}</button>
                  <button class="mobile-drawer-item" onClick={handleDuplicatePage}>{t('duplicate')} {t('page')}</button>
                  <button class="mobile-drawer-item" onClick={async () => { await copyPage(currentPageNumber()); setPagesOpen(false); }}>{t('copy')} {t('page')}</button>
                  <button class="mobile-drawer-item" onClick={async () => { await cutPage(currentPageNumber()); setPagesOpen(false); }}>{t('cut')} {t('page')}</button>
                  <button class="mobile-drawer-item" onClick={async () => { await pastePage(currentPageNumber()); setPagesOpen(false); }}>{t('paste')} {t('page')}</button>
                  <button class="mobile-drawer-item" onClick={async () => { await deletePages([currentPageNumber()]); setPagesOpen(false); }}>{tRibbon('organize.deletePage')}</button>
                  <button class="mobile-drawer-item" onClick={() => handleMovePage(-1)}>{tDialogs('insertPage.moveUp', 'Move up')}</button>
                  <button class="mobile-drawer-item" onClick={() => handleMovePage(1)}>{tDialogs('insertPage.moveDown', 'Move down')}</button>
                  <button class="mobile-drawer-item" onClick={() => replacePdfInputRef?.click()}>{t('edit')} {t('page')}</button>
                  <button class="mobile-drawer-item" onClick={() => mergePdfInputRef?.click()}>{tRibbon('organize.mergePdfs')}</button>
                  <button class="mobile-drawer-item" onClick={() => openPageDialog('extract-pages')}>{tRibbon('organize.extractPages')}</button>
                  <button class="mobile-drawer-item" disabled={!undoEnabled()} onClick={() => handleHistoryAction('undo')}>{t('undo')}</button>
                  <button class="mobile-drawer-item" disabled={!redoEnabled()} onClick={() => handleHistoryAction('redo')}>{t('redo')}</button>
                </div>
              </Show>
              <div class="mobile-drawer-section-label">{t('edit')}</div>
              <button class="mobile-drawer-item" onClick={() => setAdvancedOpen(!advancedOpen())}><span>{tRibbon('tabs.organize')}</span></button>
              <button class="mobile-drawer-item" onClick={() => { setDrawerOpen(false); setPropertiesOpen(true); }}>{tRibbon('comment.properties')}</button>
              <Show when={advancedOpen()}>
                <div class="mobile-drawer-submenu">
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('watermark')}>{tRibbon('organize.addWatermark')}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('header-footer')}>{tRibbon('organize.addHeaderFooter')}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('manage-watermarks')}>{tDialogs('manageWatermarks.title', tRibbon('organize.manageWatermarks'))}</button>
                  <button class="mobile-drawer-item" onClick={() => chooseTool('signature')}>{tRibbon('comment.signature')}</button>
                  <button class="mobile-drawer-item" onClick={() => chooseTool('stamp')}>{tRibbon('comment.stamp')}</button>
                  <button class="mobile-drawer-item" onClick={() => { setAdvancedOpen(false); addBookmark(); }}>{tProperties('addBookmark', 'Add bookmark')}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('ocr-language')}>{tRibbon('organize.ocr')}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('crop-margins')}>{tDialogs('cropMargins.title', tRibbon('home.cropMargins'))}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('resize-pages')}>{tDialogs('resizePages.title', tRibbon('home.resizePages'))}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('compress')}>{tDialogs('compress.title', 'Compress PDF')}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('page-setup')}>{tDialogs('pageSetup.title', 'Page Setup')}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('shift-page')}>{tRibbon('organize.shiftPage')}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('page-properties')}>{tDialogs('pageProperties.title', 'Page Properties')}</button>
                  <button class="mobile-drawer-item" onClick={() => openAdvancedDialog('doc-properties')}>{tDialogs('docProperties.title', 'Document Properties')}</button>
                </div>
              </Show>
            </Show>
            <div class="mobile-drawer-divider"></div>

            {/* Recent files */}
            <Show when={recentFiles().length > 0}>
              <div class="mobile-drawer-section-label">Recent Files</div>
              <For each={recentFiles()}>
                {(recent) => (
                  <button class="mobile-recent-item" onClick={() => handleOpenRecent(recent)}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                    <span class="mobile-recent-item-name">{recent.name}</span>
                  </button>
                )}
              </For>
              <button class="mobile-recent-clear" onClick={handleClearRecents}>
                Clear Recent Files
              </button>
              <div class="mobile-drawer-divider"></div>
            </Show>

            <button class="mobile-drawer-item" onClick={() => { setDrawerOpen(false); setPrefsOpen(true); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
              <span>{t('preferences')}</span>
            </button>
            <button class="mobile-drawer-item" onClick={() => { setDrawerOpen(false); window.dispatchEvent(new CustomEvent('show-about')); }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>{tRibbon('help.about')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Mobile preferences full-screen page */}
      <Show when={prefsOpen()}>
        <MobilePreferences
          onClose={() => setPrefsOpen(false)}
          onThemeChange={(theme) => {
            if (theme !== 'light') darkThemeName = theme;
            setDarkMode(theme !== 'light');
          }}
        />
      </Show>

      <Show when={propertiesOpen()}>
        <div class="mobile-properties-overlay" onClick={() => setPropertiesOpen(false)}>
          <div class="mobile-properties-sheet" onClick={(e) => e.stopPropagation()}>
            <div class="mobile-properties-header">
              <span>{tRibbon('comment.properties')}</span>
              <button class="mobile-topbar-btn" onClick={() => setPropertiesOpen(false)} aria-label={t('close')}>×</button>
            </div>
            <PropertiesPanel />
          </div>
        </div>
      </Show>

      {/* The desktop host is also required on Android: text insertion, PDF
          text editing, signatures, stamps and page dialogs all render here. */}
      <DialogHost />
      <LoadingOverlay />
    </div>
  );
}

function MobilePreferences(props) {
  const { t } = useTranslation('preferences');
  const { t: tRibbon } = useTranslation('ribbon');

  function update(key, value) {
    state.preferences[key] = value;
    savePreferences();
  }

  function handleThemeChange(value) {
    update('theme', value);
    applyTheme(value);
    const resolved = value === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : value;
    props.onThemeChange?.(resolved);
  }

  function handleLanguageChange(value) {
    update('language', value);
    changeLanguage(value);
  }

  return (
    <div class="mobile-prefs-page">
      <div class="mobile-prefs-header">
        <button class="mobile-topbar-btn" onClick={props.onClose} aria-label="Back">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span class="mobile-prefs-title">Preferences</span>
      </div>

      <div class="mobile-prefs-body">
        <div class="mobile-prefs-section">
          <div class="mobile-prefs-section-title">{t('general.theme')}</div>
          <select value={state.preferences.theme || 'system'} onChange={e => handleThemeChange(e.target.value)}>
            <option value="system">{tRibbon('theme.system')}</option>
            <option value="light">{tRibbon('theme.light')}</option>
            <option value="dark">{tRibbon('theme.dark')}</option>
            <option value="blue">{tRibbon('theme.blue')}</option>
            <option value="highContrast">{tRibbon('theme.highContrast')}</option>
          </select>
        </div>

        <div class="mobile-prefs-section">
          <div class="mobile-prefs-section-title">{t('general.language')}</div>
          <select value={state.preferences.language || 'auto'} onChange={e => handleLanguageChange(e.target.value)}>
            <For each={LANGUAGES}>
              {(lang) => <option value={lang.code}>{lang.code === 'auto' ? 'Auto-detect' : lang.name}</option>}
            </For>
          </select>
        </div>

        <div class="mobile-prefs-section">
          <div class="mobile-prefs-section-title">{t('general.author')}</div>
          <input type="text" value={state.preferences.authorName || ''} onInput={e => update('authorName', e.target.value)} placeholder="Author name" />
        </div>

        <div class="mobile-prefs-section">
          <div class="mobile-prefs-section-title">{t('annotations.generalDefaults')}</div>
          <div class="mobile-prefs-row">
            <label>{t('annotations.defaultAnnotationColor')}</label>
            <input type="color" value={state.preferences.defaultAnnotationColor || '#ff0000'} onInput={e => update('defaultAnnotationColor', e.target.value)} />
          </div>
          <div class="mobile-prefs-row">
            <label>{t('annotations.defaultLineWidth')}</label>
            <input type="number" min="1" max="20" value={state.preferences.defaultLineWidth || 3} onInput={e => update('defaultLineWidth', parseInt(e.target.value) || 3)} />
          </div>
          <div class="mobile-prefs-row">
            <label>{t('annotations.highlightOpacity')}</label>
            <input type="range" min="10" max="100" value={state.preferences.highlightOpacity || 30} onInput={e => update('highlightOpacity', parseInt(e.target.value))} />
            <span class="mobile-prefs-range-value">{state.preferences.highlightOpacity || 30}%</span>
          </div>
        </div>

        <div class="mobile-prefs-section">
          <div class="mobile-prefs-section-title">{t('behavior.startup')}</div>
          <label class="mobile-prefs-toggle">
            <span>{t('behavior.restoreLastSession')}</span>
            <input type="checkbox" checked={state.preferences.restoreLastSession ?? true} onChange={e => update('restoreLastSession', e.target.checked)} />
          </label>
        </div>

        <div class="mobile-prefs-section">
          <div class="mobile-prefs-section-title">{t('behavior.deletion')}</div>
          <label class="mobile-prefs-toggle">
            <span>{t('behavior.confirmBeforeDeleting')}</span>
            <input type="checkbox" checked={state.preferences.confirmBeforeDelete ?? true} onChange={e => update('confirmBeforeDelete', e.target.checked)} />
          </label>
        </div>
      </div>
    </div>
  );
}
