// 邮箱账号（来自配置）+ 内外部判定。
//
// ⚠ 这个文件里最要紧的是 isExternalRecipients：它决定一封邮件能不能直发。
//   判错一次 = 以本人名义把 AI 写的东西发给了客户。所以两条原则：
//     ① 收件人看全（to + cc + bcc），只要有一个外部就整封算外部；
//     ② 认不出来一律算外部（空收件人、空地址、畸形地址）——拿不准就关门。
//
// ⚠⚠ 账号表和内部域名都是**函数**不是常量：值来自配置文件，模块加载时读死会让
//   测试换不掉，也会让 mailroom setup 写完配置后当前进程还看着旧值。

import { config } from '../config.mjs';

// 哪些域名算「自己人」。空 = 一个都不算 → 所有外发邮件都只存草稿（最保守，见上面第②条）。
export function internalDomains() {
  const d = config().mail?.internalDomains;
  return Array.isArray(d) ? d.filter(Boolean).map((x) => String(x).toLowerCase()) : [];
}

export function accounts() {
  const a = config().mail?.accounts;
  return Array.isArray(a) ? a.filter((x) => x && x.id && x.address) : [];
}

export function accountById(id) {
  return accounts().find((a) => a.id === id);
}

// "Wang Xiaoming" <a@b.com> / 王小明 <x@y.com> / a@b.com / <a@b.com>
export function parseAddress(s) {
  const raw = String(s == null ? '' : s).trim();
  if (!raw) return { name: '', address: '' };
  const m = /^(.*?)<([^<>]+)>\s*$/.exec(raw);
  if (m) {
    return {
      name: m[1].trim().replace(/^["']|["']$/g, '').trim(),
      address: m[2].trim(),
    };
  }
  return { name: '', address: raw };
}

export function parseAddressList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(parseAddress).filter((p) => p.address);

  // 扫描字符串，只在「既不在双引号内、也不在尖括号内」的逗号处切分。
  // 处理 "Wang, Xiaoming" <a@b.com> 这种显示名含逗号的格式。
  const str = String(v);
  const parts = [];
  let current = '';
  let inQuote = false;
  let inAngle = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === '<' && !inQuote) {
      inAngle = true;
      current += ch;
    } else if (ch === '>' && !inQuote) {
      inAngle = false;
      current += ch;
    } else if (ch === ',' && !inQuote && !inAngle) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  if (current) parts.push(current);

  return parts.map(parseAddress).filter((p) => p.address);
}

// ⚠ 域名清单**显式传下去**，不在函数体里现取。
//   这是 2026-08-08 那次缓存事故的教训：门内部自己去取名单，取到空的时候会静默 fail-open，
//   而调用方完全看不出来。传参之后「用的是哪份名单」在调用点就能读出来。
export function isInternalAddress(addr, domains = internalDomains()) {
  const at = String(addr || '').toLowerCase().lastIndexOf('@');
  if (at === -1) return false;
  const domain = String(addr).toLowerCase().slice(at + 1).trim();
  if (!domain) return false;
  // 精确相等或真子域（`.example.com` 结尾），`notexample.com` 不算
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export function isExternalRecipients({ to = [], cc = [], bcc = [] } = {}) {
  const domains = internalDomains();
  const all = [...(to || []), ...(cc || []), ...(bcc || [])]
    .map((p) => (typeof p === 'string' ? parseAddress(p).address : (p && p.address) || ''))
    .filter(Boolean);
  if (!all.length) return true;              // 认不出收件人 = 按外部处理
  return all.some((a) => !isInternalAddress(a, domains));
}
