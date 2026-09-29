import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import Dialog from '../Dialog.jsx';
import { closeDialog, showMessage } from '../../stores/dialogStore.js';
import { state, getActiveDocument, imageCache } from '../../../core/state.js';
import { createAnnotation } from '../../../annotations/factory.js';
import { recordAdd } from '../../../core/undo-manager.js';
import { showProperties } from '../../../ui/panels/properties-panel.js';
import { redrawAnnotations, redrawContinuous } from '../../../annotations/rendering.js';
import { updateStatusMessage } from '../../../ui/chrome/status-bar.js';
import { generateImageId } from '../../../utils/helpers.js';
import { useTranslation } from '../../../i18n/useTranslation.js';

const STORAGE_KEY = 'pdfEditorSignatures';
const MAX_SAVED = 5;
const CANVAS_WIDTH = 430;
const CANVAS_HEIGHT = 150;
const MAX_PLACE_WIDTH = 200;

function getSavedSignatures() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
}

function saveSignatureToStorage(dataUrl) {
  const signatures = getSavedSignatures();
  signatures.push({ dataUrl, createdAt: new Date().toISOString() });
  while (signatures.length > MAX_SAVED) signatures.shift();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(signatures));
}

function deleteSavedSignature(index) {
  const signatures = getSavedSignatures();
  signatures.splice(index, 1);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(signatures));
}

function getCroppedDataUrl(canvas) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const alpha = data[(y * w + x) * 4 + 3];
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return canvas.toDataURL('image/png');

  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad);
  maxY = Math.min(h - 1, maxY + pad);

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const cropCtx = cropCanvas.getContext('2d');
  cropCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

  return cropCanvas.toDataURL('image/png');
}

async function placeSignatureFromDataUrl(dataUrl, x, y, color, t) {
  const img = new Image();
  img.src = dataUrl;
  await new Promise((resolve) => { img.onload = resolve; });

  const imageId = generateImageId();
  imageCache.set(imageId, img);

  let width = img.naturalWidth;
  let height = img.naturalHeight;
  if (width > MAX_PLACE_WIDTH) {
    const ratio = MAX_PLACE_WIDTH / width;
    width *= ratio;
    height *= ratio;
  }

  const ann = createAnnotation({
    type: 'signature',
    page: getActiveDocument()?.currentPage || 1,
    x: x - width / 2,
    y: y - height / 2,
    width: width,
    height: height,
    imageId: imageId,
    imageData: dataUrl,
    originalWidth: img.naturalWidth,
    originalHeight: img.naturalHeight,
    color: color,
    opacity: 1,
    rotation: 0,
    locked: false
  });

  const doc = getActiveDocument();
  if (doc) doc.annotations.push(ann);
  recordAdd(ann);

  if (state.preferences.autoSelectAfterCreate) {
    const _sigDoc = getActiveDocument();
    if (_sigDoc) { _sigDoc.selectedAnnotation = ann; _sigDoc.selectedAnnotations = [ann]; }
    showProperties(ann);
  }

  if (doc?.viewMode === 'continuous') {
    redrawContinuous();
  } else {
    redrawAnnotations();
  }

  updateStatusMessage(t('signature.signaturePlaced'));
}

export default function SignatureDialog(props) {
  const { t } = useTranslation('dialogs');
  const { t: tCommon } = useTranslation('common');

  const placeX = props.data?.x || 0;
  const placeY = props.data?.y || 0;

  const [activeTab, setActiveTab] = createSignal('draw');
  const [strokeColor, setStrokeColor] = createSignal('#000000');
  const [savedSigs, setSavedSigs] = createSignal(getSavedSignatures());

  let canvasRef;
  let ctx;
  let isDrawing = false;
  let strokes = [];
  let currentStroke = null;
  let canvasSnapshot = null;

  const close = () => closeDialog('signature');

  function refreshSaved() {
    setSavedSigs(getSavedSignatures());
  }

  function drawStroke(stroke) {
    if (!ctx || stroke.points.length < 2) return;
    ctx.strokeStyle = stroke.color;
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
  }

  function redrawCanvas() {
    if (!ctx || !canvasRef) return;
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      drawStroke(stroke);
    }
  }

  function ensureCanvasContext() {
    if (!canvasRef) return null;
    // The draw tab is conditionally mounted. If the user visits Saved and
    // returns to Draw, Solid creates a new canvas element and the old 2D
    // context must not be reused.
    if (!ctx || ctx.canvas !== canvasRef) {
      ctx = canvasRef.getContext('2d');
      if (ctx) {
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = strokeColor();
        redrawCanvas();
      }
    }
    return ctx;
  }

  function canvasPoint(e) {
    if (!canvasRef) return null;
    const rect = canvasRef.getBoundingClientRect();
    // The canvas is responsive on Android. Convert CSS pixels back to the
    // fixed backing-store coordinates used by the signature image.
    return {
      x: (e.clientX - rect.left) * (CANVAS_WIDTH / rect.width),
      y: (e.clientY - rect.top) * (CANVAS_HEIGHT / rect.height),
    };
  }

  function startDraw(e) {
    if (!ensureCanvasContext()) return;
    e.preventDefault();
    if (e.pointerId !== undefined && canvasRef.setPointerCapture) {
      try { canvasRef.setPointerCapture(e.pointerId); } catch (_) { /* pointer already ended */ }
    }
    const point = canvasPoint(e);
    if (!point) return;
    isDrawing = true;
    currentStroke = { color: strokeColor(), points: [point] };
    canvasSnapshot = ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  function continueDraw(e) {
    if (!isDrawing || !currentStroke || !ctx || !canvasRef) return;
    e.preventDefault();
    const point = canvasPoint(e);
    if (!point) return;
    currentStroke.points.push(point);
    ctx.putImageData(canvasSnapshot, 0, 0);
    drawStroke(currentStroke);
  }

  function endDraw(e) {
    e?.preventDefault?.();
    if (isDrawing && currentStroke && currentStroke.points.length > 1) {
      strokes.push(currentStroke);
    }
    if (e?.pointerId !== undefined && canvasRef?.releasePointerCapture) {
      try { canvasRef.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    }
    currentStroke = null;
    canvasSnapshot = null;
    isDrawing = false;
  }

  function undoLastStroke() {
    if (strokes.length === 0) return;
    strokes.pop();
    ensureCanvasContext();
    redrawCanvas();
  }

  function clearCanvas() {
    strokes = [];
    currentStroke = null;
    ensureCanvasContext();
    if (ctx && canvasRef) {
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
  }

  function handlePlace() {
    if (strokes.length === 0) {
      showMessage(t('signature.drawFirst'));
      return;
    }
    const dataUrl = getCroppedDataUrl(canvasRef);
    placeSignatureFromDataUrl(dataUrl, placeX, placeY, strokeColor(), t);
    close();
  }

  function handleSaveAndPlace() {
    if (strokes.length === 0) {
      showMessage(t('signature.drawFirst'));
      return;
    }
    const dataUrl = getCroppedDataUrl(canvasRef);
    saveSignatureToStorage(dataUrl);
    placeSignatureFromDataUrl(dataUrl, placeX, placeY, strokeColor(), t);
    close();
  }

  function handleSavedClick(sig) {
    placeSignatureFromDataUrl(sig.dataUrl, placeX, placeY, '#000000', t);
    close();
  }

  function handleDeleteSaved(e, index) {
    e.stopPropagation();
    deleteSavedSignature(index);
    refreshSaved();
  }

  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      e.stopPropagation();
      undoLastStroke();
    }
  }

  onMount(() => {
    ensureCanvasContext();
    document.addEventListener('keydown', onKeyDown, true);
  });

  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown, true);
  });

  function switchToDrawTab() {
    setActiveTab('draw');
  }

  function switchToSavedTab() {
    setActiveTab('saved');
    refreshSaved();
  }

  const footer = (
    <div class="sig-footer-inner">
      <div class="sig-footer-left">
        <label class="sig-color-label">Color:</label>
        <input
          type="color"
          class="sig-color-input"
          value={strokeColor()}
          onInput={(e) => {
            setStrokeColor(e.target.value);
            if (ctx) ctx.strokeStyle = e.target.value;
          }}
        />
      </div>
      <div class="sig-footer-right">
        <button class="pref-btn pref-btn-secondary" onClick={clearCanvas}>{tCommon('clear')}</button>
        <button
          class="pref-btn pref-btn-secondary"
          style="color:#0078d4; border-color:#0078d4;"
          onClick={handlePlace}
        >{tCommon('place')}</button>
        <button class="pref-btn pref-btn-primary" onClick={handleSaveAndPlace}>{t('signature.saveAndPlace')}</button>
      </div>
    </div>
  );

  return (
    <Dialog
      title={t('signature.title')}
      overlayClass="sig-overlay"
      dialogClass="sig-dialog"
      headerClass="sig-header"
      bodyClass="sig-content"
      footerClass="sig-footer"
      onClose={close}
      footer={footer}
    >
      <div class="sig-tabs">
        <button
          class={`sig-tab${activeTab() === 'draw' ? ' active' : ''}`}
          onClick={switchToDrawTab}
        >{t('signature.drawTab')}</button>
        <button
          class={`sig-tab${activeTab() === 'saved' ? ' active' : ''}`}
          onClick={switchToSavedTab}
        >{t('signature.savedTab')}</button>
      </div>

      <Show when={activeTab() === 'draw'}>
        <div class="sig-draw-panel">
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onPointerDown={startDraw}
            onPointerMove={continueDraw}
            onPointerUp={endDraw}
            onPointerCancel={endDraw}
          />
        </div>
      </Show>

      <Show when={activeTab() === 'saved'}>
        <div class="sig-saved-panel">
          <Show when={savedSigs().length === 0}>
            <div class="sig-saved-empty">{t('signature.noSavedSignatures')}</div>
          </Show>
          <Show when={savedSigs().length > 0}>
            <div class="sig-saved-grid">
              <For each={savedSigs()}>
                {(sig, index) => (
                  <div class="sig-saved-item" onClick={() => handleSavedClick(sig)}>
                    <img src={sig.dataUrl} />
                    <button
                      class="sig-saved-del"
                      onClick={(e) => handleDeleteSaved(e, index())}
                    >{'\u00D7'}</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </Dialog>
  );
}
