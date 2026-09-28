import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const runtimeFiles = [
  'js/compare/compare-viewport.js',
  'js/pdf/form-layer.js',
  'js/pdf/loader.js',
  'js/pdf/page-manager.js',
  'js/search/find-controller.js',
  'js/solid/components/PrintQueueWindow.jsx',
  'js/solid/components/dialogs/NewDocDialog.jsx',
  'js/text/text-layer.js',
  'js/tools/pdf-snap-extractor.js',
  'js/ui/panels/attachments.js',
  'web-unit/src/viewer.js',
];

test('PDF.js runtime uses the legacy build for Android WebView compatibility', async () => {
  for (const relativePath of runtimeFiles) {
    const source = await readFile(path.join(projectDir, relativePath), 'utf8');
    assert.doesNotMatch(source, /(?:from|import\()\s*['"]pdfjs-dist['"]/, relativePath);
    assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.mjs/, relativePath);
    if (relativePath.endsWith('loader.js') || relativePath.endsWith('viewer.js') || relativePath.endsWith('PrintQueueWindow.jsx')) {
      assert.match(source, /pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs/, relativePath);
    }
  }
});
