// lib/result-file.cjs — 填单日志/结果的**落盘通道**（ego 通道假成功防线）
//
// ── 为什么存在（生产环境 2026-10-27 实测）────────────────────────────────
//   1) ego 撞上「空间归用户」的 hard stop 时，会**停止转发脚本的 stdout**，
//      而进程退出码仍然是 0 —— 只看 stdout / exit code 的编排层会把这种
//      半途而废判成「成功」→ 台账记了 filled、表单却是空的。这就是假成功漏洞。
//   2) ego 沙箱冻结 console（Object.isFrozen(console) === true），
//      劫持 console.log 转发会直接把脚本带崩。
//   → 唯一可靠通道：由本模块**显式落盘**；编排层进程结束后回读文件为真值来源。
//
// ── 参数（来自 bin/ego-run.ps1 wrapper 注入的 __KIT_ARGS__）──────────────
//   resultFileAttempt —— **当次尝试**专属路径（如 <slot>.s3.a2.log）。每次尝试写
//                        自己的文件，首轮失败现场不被重试覆盖（事后可查为什么挂）。
//   resultFile        —— 标准路径（<slot>.s3.log）。编排层读它 / 收尾 JSON 镜像到它。
//   两个都没有 → 全部 no-op（playwright 通道 stdout 可靠，不接此模块）。

const fs = require('fs');
const path = require('path');

const RESULT_FILE = (() => {
  try {
    const a = globalThis.__KIT_ARGS__;
    const p =
      a && typeof a.resultFileAttempt === 'string' && a.resultFileAttempt
        ? a.resultFileAttempt
        : a && typeof a.resultFile === 'string'
          ? a.resultFile
          : '';
    return p || '';
  } catch {
    return '';
  }
})();

/** 追加一行日志到当次尝试的结果文件。落盘失败**绝不影响填单**。 */
function appendResult(line) {
  if (!RESULT_FILE) return;
  try {
    fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
    fs.appendFileSync(RESULT_FILE, line + '\n', 'utf8');
  } catch {
    /* 文件通道是 best-effort */
  }
}

/**
 * 写结构化收尾结果（编排层判定成败的权威信号）。
 *
 * 写两份：<attempt>.json（当次留档）+ 标准 <slot>.json（编排层只读标准路径 ——
 * attempt 路径带 .a<N> 段，编排层不猜次数）。
 */
function writeResult(fields = {}) {
  if (!RESULT_FILE) return;
  try {
    const payload = JSON.stringify({ at: new Date().toISOString(), ...fields }, null, 2);
    const jsonPath = RESULT_FILE.replace(/\.log$/, '.json');
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, payload, 'utf8');
    const stdJson = jsonPath.replace(/\.a\d+\.json$/, '.json');
    if (stdJson !== jsonPath) fs.writeFileSync(stdJson, payload, 'utf8');
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

module.exports = { RESULT_FILE, appendResult, writeResult };
