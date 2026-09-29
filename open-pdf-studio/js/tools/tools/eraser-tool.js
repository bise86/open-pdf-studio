import { getActiveDocument, getAnnotationBounds } from '../../core/state.js';
import { execute } from '../../core/undo-manager.js';
import { cloneAnnotation, createAnnotation } from '../../annotations/factory.js';
import { eraserHitsPath } from './eraser-hit.js';

// Ink eraser (issue #329) — drag over freehand ink strokes to remove them.
//
// - Whole-stroke erase only: any ink ('draw') annotation whose path is swept
//   within the eraser radius is removed entirely (partial erase = future work).
// - Existing annotations under the stroke are removed as whole objects.
// - The same stroke also creates whiteout masks, allowing the user to erase
//   baked PDF text and images that are not represented as annotations.
// - One drag = one undo step: hits are removed live (immediate feedback) and
//   committed as a single bulkDelete on pointer-up, so Ctrl+Z restores the
//   whole stroke at once.
// - Pointer events (dispatcher-wide) make pen/stylus work out of the box.

// Eraser radius in SCREEN pixels; converted to app coordinates per stroke so
// the felt size is zoom-independent. Matches the cursor circle in ui/cursor.js.
export const ERASER_RADIUS_PX = 8;

// Module-local stroke state (never on `state` — the generic _finishDrawing
// path in the dispatcher must not see this as a drawing gesture).
let _stroke = null;

function _eraseHitsAt(ctx, x0, y0, x1, y1) {
  const doc = getActiveDocument();
  if (!doc || !_stroke) return;
  const baseTol = Math.max(ERASER_RADIUS_PX / (ctx.scale || 1.5), 1.5);
  const pageNum = _stroke.pageNum;

  const hits = new Set();
  for (let i = 0; i < doc.annotations.length; i++) {
    const ann = doc.annotations[i];
    if (ann.page !== pageNum) continue;
    if (ann.locked || ann.eraserMask) continue;
    // Half the stroke width counts too, so touching the visible line erases.
    // Draw annotations use the precise path hit-test; all other annotations
    // use their (rotation-safe enough) axis-aligned selection bounds.
    const tol = baseTol + (ann.lineWidth || 2) / 2;
    const hit = ann.type === 'draw'
      ? eraserHitsPath(x0, y0, x1, y1, ann.path, tol)
      : _segmentTouchesBounds(x0, y0, x1, y1, getAnnotationBounds(ann), tol);
    if (!hit) continue;

    if (_stroke.hitAnnotations.has(ann)) continue;
    _stroke.hitAnnotations.add(ann);

    _stroke.items.push({
      annotation: cloneAnnotation(ann),
      // Index in the pre-stroke array: undo re-inserts ascending by index,
      // which reconstructs the original order only with ORIGINAL indices
      // (post-removal indices would scramble multi-hit strokes).
      index: _stroke.origIndex.get(ann) ?? i,
    });
    hits.add(ann);
  }
  if (hits.size === 0) return;
  // REASSIGN (not splice) like the keyboard delete flow — panels observe the
  // array reference.
  doc.annotations = doc.annotations.filter(a => !hits.has(a));
  if (doc.selectedAnnotations?.some(a => hits.has(a))) {
    doc.selectedAnnotations = doc.selectedAnnotations.filter(a => !hits.has(a));
  }
  ctx.redraw();
}

// Segment-vs-expanded-rectangle test. It intentionally treats a touch on a
// rectangle edge as a hit, which makes the eraser feel natural for small text
// boxes, stamps and images on a touch screen.
function _segmentTouchesBounds(x0, y0, x1, y1, bounds, pad) {
  if (!bounds) return false;
  const left = bounds.x - pad;
  const top = bounds.y - pad;
  const right = bounds.x + bounds.width + pad;
  const bottom = bounds.y + bounds.height + pad;
  const inside = (x, y) => x >= left && x <= right && y >= top && y <= bottom;
  if (inside(x0, y0) || inside(x1, y1)) return true;
  let t0 = 0, t1 = 1;
  const dx = x1 - x0, dy = y1 - y0;
  const clip = (p, q) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, x0 - left) && clip(dx, right - x0)
    && clip(-dy, y0 - top) && clip(dy, bottom - y0);
}

function _makeWhiteoutMask(pageNum, x0, y0, x1, y1, radius) {
  const x = Math.min(x0, x1) - radius;
  const y = Math.min(y0, y1) - radius;
  const width = Math.max(Math.abs(x1 - x0), 1) + radius * 2;
  const height = Math.max(Math.abs(y1 - y0), 1) + radius * 2;
  return createAnnotation({
    type: 'mask', page: pageNum, x, y, width, height,
    color: '#ffffff', strokeColor: '#ffffff', fillColor: '#ffffff',
    lineWidth: 0, borderStyle: 'solid', opacity: 1,
    eraserMask: true, printable: true,
  });
}

function _commitStroke(ctx) {
  if (!_stroke) return;
  const items = _stroke.items;
  const masks = _stroke.masks;
  _stroke = null;
  const doc = getActiveDocument();
  const commands = [];
  if (masks.length > 0 && doc) {
    doc.annotations.push(...masks);
    commands.push({
      type: 'bulkAdd',
      items: masks.map(annotation => ({ annotation: cloneAnnotation(annotation) })),
    });
  }
  if (items.length > 0) commands.push({ type: 'bulkDelete', items });
  if (commands.length === 0) return;
  // Same command shape as recordBulkDelete — but with pre-stroke indices,
  // recorded AFTER the live removal (execute() only records; it re-applies
  // on redo, which is a no-op-safe id-based splice). Keeping both operations
  // in one compound command makes one eraser stroke one undo step.
  execute(commands.length === 1 ? commands[0] : { type: 'compound', commands });
  // Refresh the doc-info panel (annotation totals) the same way the keyboard
  // delete flow does after removing annotations.
  if (ctx?.hideProperties) ctx.hideProperties();
}

export const eraserTool = {
  name: 'eraser',
  cursor: 'crosshair', // actual circle cursor comes from ui/cursor.js

  onPointerDown(ctx, e) {
    if (e.button !== 0) return;
    if (ctx.isPdfAReadOnly && ctx.isPdfAReadOnly()) return;
    const doc = getActiveDocument();
    if (!doc) return;

    _stroke = {
      pageNum: ctx.pageNum,
      lastX: ctx.x,
      lastY: ctx.y,
      items: [],
      masks: [],
      hitAnnotations: new Set(),
      origIndex: new Map(doc.annotations.map((a, i) => [a, i])),
    };
    // A click without movement erases at the down-point too.
    _eraseHitsAt(ctx, ctx.x, ctx.y, ctx.x, ctx.y);
    const radius = Math.max(ERASER_RADIUS_PX / (ctx.scale || 1.5), 4);
    _stroke.masks.push(_makeWhiteoutMask(ctx.pageNum, ctx.x, ctx.y, ctx.x, ctx.y, radius));
  },

  onPointerMove(ctx, e) {
    if (!_stroke) return;
    if (e.buttons === 0) { _commitStroke(ctx); return; }
    // Continuous mode: crossing onto another page restarts the sweep segment
    // there instead of sweeping "through" the gap between pages.
    if (ctx.pageNum !== _stroke.pageNum) {
      _stroke.pageNum = ctx.pageNum;
      _stroke.lastX = ctx.x;
      _stroke.lastY = ctx.y;
    }
    _eraseHitsAt(ctx, _stroke.lastX, _stroke.lastY, ctx.x, ctx.y);
    const radius = Math.max(ERASER_RADIUS_PX / (ctx.scale || 1.5), 4);
    _stroke.masks.push(_makeWhiteoutMask(ctx.pageNum, _stroke.lastX, _stroke.lastY, ctx.x, ctx.y, radius));
    if (_stroke) {
      _stroke.lastX = ctx.x;
      _stroke.lastY = ctx.y;
    }
  },

  onPointerUp(ctx, e) {
    if (!_stroke) return false;
    _commitStroke(ctx);
    return true;
  },

  onDeactivate() {
    _commitStroke();
  },
};
