#!/usr/bin/env node
// bin/publish.cjs — 统一入口
//
// 让 `npx publish-kit <命令>` 和 `require('publish-kit')` 都有落点，
// 不至于装完发现 bin 指向的文件不存在。
//
//   publish-kit doctor [--no-launch]   环境体检
//   publish-kit login [平台...]        打开平台登录页
//   publish-kit init                   首次配置向导
//   publish-kit platforms              列出各平台脚本与用法
//   publish-kit help                   本帮助
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname);

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(BIN, script), ...args], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

function platformsList() {
  const dir = path.join(BIN, '..', 'platforms');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).sort() : [];
  console.log('\n平台脚本（在 publish-kit 目录下执行）：\n');
  if (!files.length) console.log('  （未找到 platforms/*.cjs）');
  for (const f of files) {
    const name = path.basename(f, '.cjs');
    const first = fs
      .readFileSync(path.join(dir, f), 'utf8')
      .split(/\r?\n/)
      .filter((l) => /node platforms\//.test(l))
      .slice(0, 3)
      .map((l) => l.trim().replace(/^\/\/\s*/, ''))
      .join('\n                 ');
    console.log(`  ${name}`);
    if (first) console.log(`    ${first}`);
    console.log('');
  }
  console.log('  每个脚本的文件头有完整用法与坑位说明，先读再改选择器。\n');
}

const HELP = `
publish-kit —— 多平台图文/视频自动填单，只填到发布按钮前，绝不点击发布

  publish-kit doctor [--no-launch]   环境体检：浏览器、CDP、各平台登录态
  publish-kit login [平台...] [--all] 打开平台登录页（只开页面，不碰登录按钮）
  publish-kit init                   首次配置向导，生成 config.yaml
  publish-kit platforms              列出各平台脚本与用法

各平台脚本需在 publish-kit 目录下直接执行，例如：
  node platforms/zhihu.cjs --video a.mp4 --title "标题" --body-file desc.txt
`;

const CMD = process.argv[2];
const REST = process.argv.slice(3);

switch (CMD) {
  case 'doctor': run('doctor.cjs', REST); break;
  case 'login': run('login.cjs', REST); break;
  case 'init': run('init.cjs', REST); break;
  case 'platforms': platformsList(); break;
  case 'help':
  case '-h':
  case '--help':
  case undefined:
    console.log(HELP);
    break;
  default:
    console.error(`\n未知命令：${CMD}`);
    console.error(HELP);
    process.exit(1);
}
