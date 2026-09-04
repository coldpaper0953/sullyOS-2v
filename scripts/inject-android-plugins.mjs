#!/usr/bin/env node
// CI 专用：把 scripts/android-plugins/*.kt 注入 cap add android 生成的壳工程。
// 壳工程每次在云端重新生成（不进 git），所以注入必须是脚本化、幂等的。
//
// 做四件事：
//   1. 复制 ApkInstallerPlugin.kt / AmsgUnifiedPushPlugin.kt 到 android/app/src/main/java/…/plugins/
//   2. MainActivity 注册这两个插件（Capacitor 6 默认自动发现 @CapacitorPlugin 注解，
//      但依赖 androidx.core 的显式注册更稳——此处直接靠注解扫描，MainActivity 无需改动）
//   3. AndroidManifest.xml 补 REQUEST_INSTALL_PACKAGES 权限 + FileProvider
//   4. app/build.gradle 补 androidx.core 依赖（UnifiedPush 广播注册要 RECEIVER_EXPORTED）
import { mkdirSync, readdirSync, readFileSync, writeFileSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const androidRoot = join(root, 'android');
const pluginSrcDir = join(root, 'scripts', 'android-plugins');

if (!existsSync(androidRoot)) {
  console.error('android/ 不存在——先跑 pnpm exec cap add android');
  process.exit(1);
}

// ---- 1. 复制插件源码到主包 plugins 目录 ----
const mainSrcRoot = join(androidRoot, 'app', 'src', 'main', 'java');
const pkgDirs = readdirSync(mainSrcRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory());
// capacitor appId com.aetheros.simulator → com/aetheros/simulator
const cfg = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8'));
const appIdPath = cfg.appId.split('.').join('/');
const targetPkgDir = join(mainSrcRoot, appIdPath, 'plugins');
mkdirSync(targetPkgDir, { recursive: true });

const pluginFiles = readdirSync(pluginSrcDir).filter((f) => f.endsWith('.kt'));
for (const f of pluginFiles) {
  cpSync(join(pluginSrcDir, f), join(targetPkgDir, f));
  console.log(`[inject] ${f} -> app/src/main/java/${appIdPath}/plugins/`);
}

// 包名声明对齐壳的 applicationId（模板里是 placeholder，必须替换成真包名）
for (const f of pluginFiles) {
  const p = join(targetPkgDir, f);
  let s = readFileSync(p, 'utf8');
  const wanted = `${cfg.appId}.plugins`;
  s = s.replace(/^package\s+[\w.]+/m, `package ${wanted}`);
  writeFileSync(p, s);
  console.log(`[inject] ${f}: package 改为 ${wanted}`);
}

// ---- 2. AndroidManifest.xml 补权限 + FileProvider ----
const manifestPath = join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
let manifest = readFileSync(manifestPath, 'utf8');
if (!manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
  manifest = manifest.replace(
    /(<manifest[^>]*>)/,
    `$1\n    <!-- ApkInstaller 应用内更新：允许下载后唤起系统安装器 -->\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`,
  );
  console.log('[inject] manifest: +REQUEST_INSTALL_PACKAGES');
}
if (!manifest.includes('android.permission.POST_NOTIFICATIONS')) {
  manifest = manifest.replace(
    /(<manifest[^>]*>)/,
    `$1\n    <!-- Android 13+ 通知权限（UnifiedPush / 本地通知） -->\n    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />`,
  );
  console.log('[inject] manifest: +POST_NOTIFICATIONS');
}
const fileProviderXml = `    <provider
        android:name="androidx.core.content.FileProvider"
        android:authorities="\${applicationId}.fileprovider"
        android:exported="false"
        android:grantUriPermissions="true">
        <meta-data
            android:name="android.support.FILE_PROVIDER_PATHS"
            android:resource="@xml/file_paths" />
    </provider>`;
if (!manifest.includes('FileProvider')) {
  manifest = manifest.replace(/<\/application>/, `${fileProviderXml}\n    </application>`);
  console.log('[inject] manifest: +FileProvider');
}
writeFileSync(manifestPath, manifest);

// file_paths.xml：允许 cache/updates 下的 APK 通过 FileProvider 分享给系统安装器
const xmlDir = join(androidRoot, 'app', 'src', 'main', 'res', 'xml');
mkdirSync(xmlDir, { recursive: true });
const filePaths = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="updates" path="updates/" />
    <cache-path name="cache_root" path="." />
</paths>`;
writeFileSync(join(xmlDir, 'file_paths.xml'), filePaths);
console.log('[inject] res/xml/file_paths.xml');

// ---- 3. app/build.gradle：加 Kotlin 插件 + androidx.core ----
// cap add android 的模板只有 com.android.application——没有 kotlin-android 插件，
// 放进去的 .kt 根本不参与编译（v1.0.0/v1.0.1 两次构建插件类没进 dex 的根因）。
const gradlePath = join(androidRoot, 'app', 'build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
if (!gradle.includes('kotlin-android')) {
  gradle = gradle.replace(
    /apply plugin: 'com\.android\.application'/,
    `apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'`,
  );
  console.log('[inject] build.gradle: +kotlin-android');
}
if (!gradle.includes('kotlin-gradle-plugin')) {
  // 根 build.gradle 要有 kotlin classpath 才能 apply kotlin-android
  const rootGradlePath = join(androidRoot, 'build.gradle');
  let rootGradle = readFileSync(rootGradlePath, 'utf8');
  if (!rootGradle.includes('kotlin-gradle-plugin')) {
    rootGradle = rootGradle.replace(
      /(dependencies\s*\{)/,
      `$1\n        classpath "org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.10"`,
    );
    writeFileSync(rootGradlePath, rootGradle);
    console.log('[inject] root build.gradle: +kotlin classpath');
  }
}
if (!gradle.includes('androidx.core:core:')) {
  gradle = gradle.replace(
    /(dependencies\s*\{)/,
    `$1\n    implementation "androidx.core:core:1.13.1"`,
  );
  console.log('[inject] build.gradle: +androidx.core');
}
writeFileSync(gradlePath, gradle);

// ---- 4. 完整性自检：源文件必须在壳的源码集里，包名必须已替换 ----
for (const f of pluginFiles) {
  const p = join(targetPkgDir, f);
  const s = readFileSync(p, 'utf8');
  if (!s.includes(`package ${cfg.appId}.plugins`)) {
    console.error(`[inject] ${f}: package 行没有替换成 ${cfg.appId}.plugins —— 模板文件坏了`);
    process.exit(1);
  }
}
const ktCount = readdirSync(targetPkgDir).filter((f) => f.endsWith('.kt')).length;
if (ktCount !== pluginFiles.length) {
  console.error(`[inject] 目标目录 .kt 数量不符（${ktCount} vs ${pluginFiles.length}）`);
  process.exit(1);
}
console.log('[inject] 完成。');
