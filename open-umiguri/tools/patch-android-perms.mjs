#!/usr/bin/env node
// patch-android-perms.mjs - 给 Android 工程声明「所有文件访问」等权限(可复现)。
//
// src-tauri/gen/ 不入库(Tauri 每次 tauri android init 重新生成), 因此权限声明必须
// 用脚本重放。缺 MANAGE_EXTERNAL_STORAGE 的后果:
//   1) 系统「特殊应用权限 -> 所有文件访问」列表里没有本应用条目;
//   2) Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION 抛
//      ActivityNotFoundException —— 用户看到的就是「无法授权所有文件管理权限」;
//   3) 就算用别的方式开了, readdir 仍会被隐藏非本应用归属的目录条目:
//      用户拷进 Documents/UMIGURI 的补丁数据「文件打不开、目录列举为空」。
//
// 用法: node tools/patch-android-perms.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = path.join(root, 'src-tauri', 'gen', 'android');
if (!fs.existsSync(androidDir)) {
  console.log('patch-android-perms: 没有 gen/android(先跑一次 tauri android init), 跳过');
  process.exit(0);
}

const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
if (!fs.existsSync(manifestPath)) {
  console.log('patch-android-perms: 找不到 ' + manifestPath + ', 跳过');
  process.exit(0);
}

let xml = fs.readFileSync(manifestPath, 'utf8');
const eol = xml.includes('\r\n') ? '\r\n' : '\n';
let changed = false;

// 1) <uses-permission>: MANAGE_EXTERNAL_STORAGE(API 30+ 的「所有文件访问」),
//    外加旧的 READ/WRITE_EXTERNAL_STORAGE(maxSdkVersion=32) 覆盖 API 30 以前的设备。
const perms = [
  ['MANAGE_EXTERNAL_STORAGE', ''],
  ['READ_EXTERNAL_STORAGE', ' android:maxSdkVersion="32"'],
  ['WRITE_EXTERNAL_STORAGE', ' android:maxSdkVersion="32"'],
];
const missing = perms.filter(([name]) => !xml.includes('android:name="android.permission.' + name + '"'));
if (missing.length) {
  const m = xml.match(/<manifest\b[^>]*>/);
  if (!m) {
    console.error('patch-android-perms: 找不到 <manifest> 标签, 放弃');
    process.exit(1);
  }
  const block =
    eol +
    '    <!-- UMIGURI: 「所有文件访问」。缺这条则系统设置里没有本应用条目, 授权页也会抛 ActivityNotFoundException。 -->' +
    eol +
    missing
      .map(([name, extra]) => '    <uses-permission android:name="android.permission.' + name + '"' + extra + ' />')
      .join(eol) +
    eol;
  xml = xml.slice(0, m.index + m[0].length) + block + xml.slice(m.index + m[0].length);
  changed = true;
}

// 1.5) USB Host: 手台走 USB-OTG, 必须声明 uses-feature。缺它时 Android 不会弹
//      USB 权限框, openDevice() 直接返回 null —— 玩家看到的是「安卓无法使用手台」。
const usbFeature = '<uses-feature android:name="android.hardware.usb.host" />';
if (!xml.includes('android.hardware.usb.host')) {
  const mf = xml.match(/<manifest\b[^>]*>/);
  if (mf) {
    xml = xml.slice(0, mf.index + mf[0].length) + eol + '    ' + usbFeature + eol + xml.slice(mf.index + mf[0].length);
    changed = true;
  }
}

// 2) <application android:requestLegacyExternalStorage="true">: API 29 上维持旧的
//    分区存储行为(API 30+ 无影响, 但对 29 是必需的)。
if (!xml.includes('requestLegacyExternalStorage') && /<application\s/.test(xml)) {
  xml = xml.replace(/<application(\s)/, '<application' + eol + '        android:requestLegacyExternalStorage="true"$1');
  changed = true;
}

if (changed) {
  fs.writeFileSync(manifestPath, xml);
  console.log('patch-android-perms: 已改写 ' + path.relative(root, manifestPath));
} else {
  console.log('patch-android-perms: 已是目标状态');
}

// 复核: 逐项确认都写进去了(改动幂等, 可反复跑)。
if (!xml.includes('android.hardware.usb.host')) {
  console.error('patch-android-perms: 缺少 android.hardware.usb.host !');
  process.exit(1);
}
for (const [name] of perms) {
  if (!xml.includes('android:name="android.permission.' + name + '"')) {
    console.error('patch-android-perms: 缺少 ' + name + ' !');
    process.exit(1);
  }
}
if (!xml.includes('requestLegacyExternalStorage')) {
  console.error('patch-android-perms: 缺少 requestLegacyExternalStorage !');
  process.exit(1);
}
console.log('patch-android-perms: 权限声明就绪 (' + perms.map(([n]) => n).join(', ') + ')');
