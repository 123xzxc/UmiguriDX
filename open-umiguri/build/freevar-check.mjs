// 自由变量检查: 反混淆后的 bundle 不应出现「有引用、无声明」的 m_/v_ 名字。
// 这类断裂正是 deobfuscate.js 旧 bug 的表现(如 v_t_28347)。
// 用法: node build/freevar-check.mjs [file]   (默认 dist/game.raw.js)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parser, traverse } from '../tools/lib/symbols.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist/game.raw.js');
if (!fs.existsSync(file)) {
  console.error(`缺少 ${file}(先 npm run assemble:game 或 npm run build:game)`);
  process.exit(2);
}
const code = fs.readFileSync(file, 'utf8');
const ast = parser.parse(code, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: true });

const bad = new Map();
// 另有几类「裸名字」不匹配 m_/v_, 但同样会让整个游戏停摆, 一并拦:
//   scope —— 游戏模块依赖的注入对象。它必须定义在工厂函数**内部**(作为参数);
//            放到模块顶层就成了裸的自由变量, 而模块代码会被 esbuild 包进一个 IIFE。
//            直接 eval 下它能侥幸命中全局变量, 一旦换别的加载方式(或混淆器只重命名
//            它认识的那个 scope)就变成 "Can't find variable: scope" —— 整个游戏黑屏。
//
// 只盯 scope: umgr_elc / glRuntime 是**故意**的全局桥(vendor 片段与宿主在加载时挂到
// globalThis), 它们在 bundle 里本来就没有声明, 不能算错。
const WATCHED = new Set(['scope']);
traverse(ast, {
  ReferencedIdentifier(p) {
    const name = p.node.name;
    if (p.scope.getBinding(name)) return;
    if (!/^[mv]_[A-Za-z0-9_$]+/.test(name) && !WATCHED.has(name)) return;
    bad.set(name, (bad.get(name) || 0) + 1);
  },
});

if (bad.size) {
  console.error(`发现未声明的反混淆名字 ${bad.size} 种(例):`);
  for (const [n, c] of [...bad].slice(0, 20)) console.error(`  ${c}\t${n}`);
  process.exit(1);
}
console.log(`freevar 检查通过: ${path.relative(root, file)} 无未声明的 m_/v_ 名字与裸 scope/全局桥`);
