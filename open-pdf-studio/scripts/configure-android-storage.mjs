import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(projectDir, 'src-tauri', 'gen', 'android');
const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');

const READ_PERMISSION = 'android.permission.READ_EXTERNAL_STORAGE';
const MAIN_ACTIVITY_MARKER = 'OPEN_PDF_STUDIO_STORAGE_PERMISSION';

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function addReadPermission(manifest) {
  if (manifest.includes(`android:name="${READ_PERMISSION}"`)) return manifest;
  const manifestTag = /<manifest\b[^>]*>/;
  if (!manifestTag.test(manifest)) {
    throw new Error('AndroidManifest.xml does not contain a manifest element');
  }
  return manifest.replace(
    manifestTag,
    (tag) => `${tag}\n    <uses-permission android:name="${READ_PERMISSION}" />`,
  );
}

function importsFor(source) {
  const imports = [
    'import android.Manifest',
    'import android.content.pm.PackageManager',
    'import android.os.Build',
    'import android.os.Bundle',
  ];
  const packageLine = source.match(/^package .*$/m);
  if (!packageLine) throw new Error('MainActivity.kt does not contain a package declaration');
  const missing = imports.filter((line) => !source.includes(line));
  if (missing.length === 0) return source;
  return source.replace(packageLine[0], `${packageLine[0]}\n\n${missing.join('\n')}`);
}

export function addRuntimeReadPermission(source) {
  if (source.includes(MAIN_ACTIVITY_MARKER)) return source;
  source = importsFor(source);
  const classMatch = /class\s+MainActivity\s*:\s*TauriActivity\s*\(\s*\)(\s*\{)?/m.exec(source);
  if (!classMatch) throw new Error('MainActivity.kt does not contain a Tauri MainActivity class');

  const classStart = classMatch.index + classMatch[0].length;
  const permissionCode = `
        // ${MAIN_ACTIVITY_MARKER}: Android 10-12 require runtime storage permission.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            Build.VERSION.SDK_INT <= 32 &&
            checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE), STORAGE_PERMISSION_REQUEST_CODE)
        }`;
  const companion = `

    companion object {
        private const val STORAGE_PERMISSION_REQUEST_CODE = 4101
    }
`;

  // Tauri's generated activity already defines onCreate(). Add the request to
  // that method instead of declaring a second override with the same signature.
  const onCreate = /override\s+fun\s+onCreate\s*\(\s*savedInstanceState:\s*Bundle\?\s*\)\s*\{/m.exec(source);
  if (onCreate) {
    const methodStart = onCreate.index + onCreate[0].length;
    const superCall = /super\.onCreate\(savedInstanceState\)/m.exec(source.slice(methodStart));
    if (!superCall) throw new Error('MainActivity.kt onCreate does not call super.onCreate');
    const insertAt = methodStart + superCall.index + superCall[0].length;
    const withPermission = `${source.slice(0, insertAt)}${permissionCode}${source.slice(insertAt)}`;
    const closingBrace = withPermission.lastIndexOf('}');
    if (closingBrace < insertAt) throw new Error('MainActivity.kt has an invalid class body');
    return `${withPermission.slice(0, closingBrace)}${companion}${withPermission.slice(closingBrace)}`;
  }

  const body = `
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)${permissionCode}
    }
${companion}`;

  if (classMatch[1]) {
    const closingBrace = source.lastIndexOf('}');
    if (closingBrace < classStart) throw new Error('MainActivity.kt has an invalid class body');
    return `${source.slice(0, closingBrace)}${body}${source.slice(closingBrace)}`;
  }

  return `${source.slice(0, classStart)} {${body}}${source.slice(classStart)}`;
}

async function findMainActivity(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findMainActivity(entryPath);
      if (found) return found;
    } else if (entry.name === 'MainActivity.kt') {
      return entryPath;
    }
  }
  return null;
}

export async function configureAndroidStorage(root = androidDir) {
  const manifest = path.join(root, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!(await exists(manifest))) throw new Error(`Android manifest not found: ${manifest}`);
  const mainActivity = await findMainActivity(path.join(root, 'app', 'src', 'main', 'java'));
  if (!mainActivity) throw new Error(`MainActivity.kt not found under ${root}`);

  const currentManifest = await readFile(manifest, 'utf8');
  const nextManifest = addReadPermission(currentManifest);
  if (nextManifest !== currentManifest) await writeFile(manifest, nextManifest);

  const currentActivity = await readFile(mainActivity, 'utf8');
  const nextActivity = addRuntimeReadPermission(currentActivity);
  if (nextActivity !== currentActivity) await writeFile(mainActivity, nextActivity);

  return { manifest, mainActivity };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await configureAndroidStorage();
  console.log(`Configured Android storage permission in ${result.manifest}`);
  console.log(`Configured runtime permission request in ${result.mainActivity}`);
}
