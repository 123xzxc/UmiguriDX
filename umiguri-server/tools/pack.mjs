// 打包可部署产物: dist/umiguri-server-<version>.tar.gz
//
// 服务端零第三方依赖, 所以产物只需要 src/ + package.json + README.md,
// 外加一份部署说明。解包后 `node src/index.js` 即可运行, 无需 npm install。
//
// 用法: node tools/pack.mjs [--out dist]
//
// 特意不打包: data/(运行时数据库)、test/(开发用)、tools/(本脚本自身)。

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const outDir = resolve(root, arg("--out", "dist"));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const stageName = "umiguri-server-" + pkg.version;
const stage = join(outDir, stageName);

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

for (const item of ["src", "package.json", "README.md", ".gitignore"]) {
  try {
    await cp(join(root, item), join(stage, item), { recursive: true });
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}

// 部署说明: 产物里没有 tools/, 这条必须随包带上
const deployNote = [
  "# umiguri-server " + pkg.version + " 部署",
  "",
  "零第三方依赖, 无需 npm install。需要 Node.js >= 22.5(用到内置 node:sqlite)。",
  "",
  "```bash",
  "# 生产环境必须设这两项: JWT 密钥与管理员令牌",
  "export UMIGURI_JWT_SECRET=$(head -c 32 /dev/urandom | base64)",
  "export UMIGURI_ADMIN_TOKEN=$(head -c 24 /dev/urandom | base64 | tr -d +/=)",
  "export UMIGURI_PORT=8787",
  "",
  "node src/index.js",
  "```",
  "",
  "首次启动后:",
  "- 管理面板: 浏览器打开 /admin-panel, 粘贴管理员令牌登录;",
  "  建号会返回 TOTP 密钥, 交给玩家在验证器 App 里手动输入绑定;",
  "- 玩家面板: /panel, 玩家用用户名 + 验证码登录, 自行生成卡号。",
  "",
  "不用网页也能建号: POST /admin/users (Bearer 管理员令牌)。",
  "",
  "详见 README.md。",
  "",
].join("\n");
await writeFile(join(stage, "DEPLOY.md"), deployNote, "utf8");

const tgz = join(outDir, stageName + ".tar.gz");
await new Promise((ok, bad) => {
  const ps = spawn("tar", ["-czf", tgz, "-C", outDir, stageName], { stdio: "inherit" });
  ps.on("error", bad);
  ps.on("exit", (code) => (code === 0 ? ok() : bad(new Error("tar 退出码 " + code))));
});

const size = (await stat(tgz)).size;
console.log("[pack] " + tgz + "  (" + (size / 1024).toFixed(1) + " KB)");
