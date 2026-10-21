// lib/log.cjs — 运行日志：每平台一份独立日志 + 耗时拆解
//
// 为什么需要：8 个平台各跑一遍时，**「慢在哪」不该靠猜**。
// 以前只能看总耗时猜，现在每个平台落一份独立日志，里面有：
//   · 带时间戳的每一步（哪一步吃掉了 40 秒一目了然）
//   · 收尾的步骤耗时表（按耗时倒序）
//   · 告警汇总（跑完不用再翻控制台找 ⚠）
//
// 用法：
//   const log = require('../lib/log.cjs').create({ platform: 'douyin', kind: 'video' });
//   log.step('上传视频', '已提交 1.9MB');      // 记一步
//   log.warn('话题没选上');
//   log.finish();                               // 打印耗时表 + 告警汇总
//
// 日志落 config.yaml 的 publish.log_dir（默认 ./logs）。

const fs = require('fs');
const path = require('path');
const cfg = require('./config.cjs');

function logDir() {
  const v = cfg.load().publish.log_dir || './logs';
  return path.isAbsolute(v) ? v : path.join(cfg.ROOT, v);
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/**
 * 创建一个平台运行日志器。
 * @param {Object} opts
 * @param {string} opts.platform 平台 key（douyin / weibo …）
 * @param {string} [opts.kind] 线（image / video）
 * @param {string} [opts.tag] 额外区分标记（如重跑轮次）
 */
function create({ platform, kind = '', tag = '' } = {}) {
  const t0 = Date.now();
  const steps = [];
  const warns = [];
  const lines = [];
  const name = [platform, kind, tag].filter(Boolean).join('-');
  const file = path.join(logDir(), `${name}-${Date.now()}.log`);

  const push = (level, msg) => {
    const line = `[${stamp()}] [${level}] ${msg}`;
    lines.push(line);
    if (level === 'WARN') console.warn(line);
    else console.log(line);
  };

  const api = {
    file,
    /** 记一个步骤 */
    step(msg, detail = '') {
      const t = Date.now();
      steps.push({ msg, detail, ms: t - t0, at: t });
      push('step', msg + (detail ? ` — ${detail}` : ''));
      return api;
    },
    /** 记一个告警（收尾会汇总） */
    warn(msg) {
      warns.push(msg);
      push('WARN', msg);
      return api;
    },
    /** 记一条信息 */
    info(msg) {
      push('info', msg);
      return api;
    },
    /** 收尾：打印耗时表 + 告警汇总，并写盘 */
    finish(status = 'ok') {
      const total = Date.now() - t0;
      steps.sort((a, b) => b.ms - a.ms);
      const header =
        `\n===== ${name} ${status} · 总耗时 ${(total / 1000).toFixed(1)}s =====\n` +
        `--- 各步骤耗时（倒序，前 12）---\n` +
        steps
          .slice(0, 12)
          .map((s) => `  ${(s.ms / 1000).toFixed(1).padStart(7)}s  ${s.msg}${s.detail ? ` — ${s.detail}` : ''}`)
          .join('\n');
      const warnBlock = warns.length ? `\n--- 告警 ${warns.length} 条 ---\n` + warns.map((w) => `  ⚠ ${w}`).join('\n') : '';
      const foot = `${header}${warnBlock}\n`;
      console.log(foot);
      lines.push(foot);
      try {
        fs.mkdirSync(logDir(), { recursive: true });
        fs.writeFileSync(file, lines.join('\n'), 'utf8');
      } catch (e) {
        console.warn(`⚠ 日志写入失败（${e.message}）—— 不影响填单结果`);
      }
      return { file, total, steps, warns };
    },
  };
  return api;
}

module.exports = { create, logDir };
