/**
 * 装载前自检 —— 丢进酒馆之前先跑这个。
 *
 *   node tests/load-check.mjs
 *
 * 查四件事：
 *   1. manifest 必填字段、hooks 指向的函数真的导出了
 *   2. 所有相对 import 的目标存在
 *   3. App 注册表里的 load() 路径存在，且目录里有 index.js
 *   4. interceptor 真的挂到了 globalThis
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];
const read = (p) => readFileSync(p, 'utf8');

/* ---------------------------------------------------------- manifest */

const manifestPath = resolve(ROOT, 'manifest.json');
let manifest = null;

if (!existsSync(manifestPath)) {
  problems.push('缺少 manifest.json');
} else {
  manifest = JSON.parse(read(manifestPath));
  for (const key of ['display_name', 'name', 'version', 'js', 'css']) {
    if (!manifest[key]) problems.push(`manifest 缺少字段: ${key}`);
  }

  const entry = resolve(ROOT, manifest.js || '');
  if (!existsSync(entry)) problems.push(`manifest.js 指向的文件不存在: ${manifest.js}`);
  const entrySrc = existsSync(entry) ? read(entry) : '';

  for (const [hook, fn] of Object.entries(manifest.hooks ?? {})) {
    if (!new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\b`).test(entrySrc)) {
      problems.push(`hook "${hook}" 指向的 "${fn}" 没有 export`);
    }
  }

  if (manifest.generate_interceptor) {
    const name = manifest.generate_interceptor;
    if (!new RegExp(`globalThis\\.${name}\\s*=`).test(entrySrc)) {
      problems.push(`generate_interceptor "${name}" 没有挂到 globalThis`);
    } else {
      notes.push(`interceptor: globalThis.${name}(chat, contextSize, abort, type)`);
    }
  }

  const css = resolve(ROOT, manifest.css || '');
  if (!existsSync(css)) problems.push(`manifest.css 不存在: ${manifest.css}`);
}

/* ----------------------------------------------------------- imports */

const JS = [];
(function walk(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'tests'].includes(item.name)) continue;
    const full = resolve(dir, item.name);
    if (item.isDirectory()) walk(full);
    else if (/\.(js|mjs)$/.test(item.name)) JS.push(full);
  }
})(ROOT);

let importCount = 0;
for (const file of JS) {
  const src = read(file);
  for (const m of src.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
    importCount++;
    const target = resolve(dirname(file), m[1].split('?')[0]);
    if (!existsSync(target)) problems.push(`${relative(ROOT, file)} → import "${m[1]}" 不存在`);
    else if (statSync(target).isDirectory()) problems.push(`${relative(ROOT, file)} → import "${m[1]}" 指向目录`);
  }
}

/* -------------------------------------------------------------- Apps */

const appsFile = resolve(ROOT, 'ui/apps.js');
if (existsSync(appsFile)) {
  const src = read(appsFile);
  const loads = [...src.matchAll(/load:\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  if (!loads.length) problems.push('ui/apps.js 里没有找到任何 load() 动态 import');

  for (const spec of loads) {
    const target = resolve(dirname(appsFile), spec);
    if (!existsSync(target)) problems.push(`App 入口不存在: ${relative(ROOT, target)}`);
  }
  notes.push(`App: ${loads.length} 个，全部动态 import`);

  // 契约：注册表 == apps/ 目录
  const dir = resolve(ROOT, 'ui/apps');
  if (existsSync(dir)) {
    const onDisk = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    const registered = loads.map(s => s.replace(/^\.\/apps\//, '').replace(/\/index\.js$/, '').replace(/^\.\//, ''));
    const missing = onDisk.filter(d => !registered.includes(d));
    if (missing.length) notes.push(`apps/ 下有未注册的目录: ${missing.join(', ')}（不算错，只是提醒）`);
  }
}

/* ------------------------------------------------------------- 输出 */

console.log('小手机 · 装载前自检');
console.log(`  JS 文件: ${JS.length}`);
console.log(`  相对 import: ${importCount}`);
if (manifest) console.log(`  扩展: ${manifest.display_name} v${manifest.version}`);
for (const n of notes) console.log(`  · ${n}`);

if (problems.length) {
  console.error('\n发现问题:');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exitCode = 1;
} else {
  console.log('\n✓ 全部通过。复制到 SillyTavern/public/scripts/extensions/third-party/mini-phone/ 即可。');
}
