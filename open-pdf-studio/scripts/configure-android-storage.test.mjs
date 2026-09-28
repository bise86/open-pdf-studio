import assert from 'node:assert/strict';
import test from 'node:test';

import { addReadPermission, addRuntimeReadPermission } from './configure-android-storage.mjs';

const manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n</manifest>\n';

const activities = [
  `package com.example.app\n\nimport app.tauri.TauriActivity\n\nclass MainActivity : TauriActivity()\n`,
  `package com.example.app\n\nimport app.tauri.TauriActivity\n\nclass MainActivity : TauriActivity() {\n}\n`,
];

test('Android storage permission patch handles generated MainActivity forms and is idempotent', () => {
  const patchedManifest = addReadPermission(manifest);
  assert.match(patchedManifest, /android\.permission\.READ_EXTERNAL_STORAGE/);
  assert.equal(addReadPermission(patchedManifest), patchedManifest);

  for (const activity of activities) {
    const patchedActivity = addRuntimeReadPermission(activity);
    assert.match(patchedActivity, /override fun onCreate\(savedInstanceState: Bundle\?\)/);
    assert.match(patchedActivity, /requestPermissions\(arrayOf\(Manifest\.permission\.READ_EXTERNAL_STORAGE\)/);
    assert.match(patchedActivity, /Build\.VERSION\.SDK_INT <= 32/);
    assert.equal(addRuntimeReadPermission(patchedActivity), patchedActivity);
  }
});
