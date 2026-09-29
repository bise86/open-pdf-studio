import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const nativeDir = new URL('../src-tauri/', import.meta.url);
const readJson = async (file) => JSON.parse(await readFile(new URL(file, nativeDir), 'utf8'));
const base = await readJson('tauri.conf.json');
const capabilities = await Promise.all(
  (await readdir(new URL('capabilities/', nativeDir)))
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(`capabilities/${name}`)),
);

for (const platform of ['android', 'iOS']) {
  test(`${platform}: the main window receives file picker and read/write permissions`, async () => {
    const override = await readJson(`tauri.${platform.toLowerCase()}.conf.json`)
      .catch((error) => { if (error.code === 'ENOENT') return {}; throw error; });
    const windows = override.app?.windows ?? base.app.windows;
    const label = windows[0].label ?? 'main'; // Tauri's default WindowConfig label.
    const enabled = override.app?.security?.capabilities ?? base.app.security?.capabilities;
    const selected = enabled?.length
      ? enabled.map((entry) => typeof entry === 'string'
        ? capabilities.find((capability) => capability.identifier === entry)
        : entry)
      : capabilities;
    // Listing a permission without a matching window/webview grants nothing.
    // Main is a single-webview window, with both labels equal to `main`.
    const attached = selected.filter((capability) => capability
      && (!capability.platforms || capability.platforms.includes(platform))
      && capability.local !== false
      && (capability.windows?.includes(label) || capability.webviews?.includes(label)));
    assert.ok(attached.length > 0, `${platform}: no capability is bound to window ${label}`);
    const permissions = new Set(attached.flatMap((capability) => capability.permissions)
      .map((permission) => typeof permission === 'string' ? permission : permission.identifier));
    for (const permission of [
      'core:default', 'dialog:allow-open', 'dialog:allow-save',
      'fs:read-all', 'fs:write-all', 'fs:allow-stat',
    ]) {
      assert.ok(permissions.has(permission), `${platform}/${label} is missing ${permission}`);
    }
  });
}

test('Android minimum SDK remains Android 10 (API 29)', async () => {
  const android = await readJson('tauri.android.conf.json');
  assert.equal(android.bundle.android.minSdkVersion, 29);
});
