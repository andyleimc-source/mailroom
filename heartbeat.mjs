// 心跳加速与阶梯衰退机制
// 状态存放在 ~/.mailroom/heartbeat.json
//
// 阶梯设计：
//   0 ~ 3 分钟（热区）：1 分钟 (60s)
//   3 ~ 10 分钟（温区）：2 分钟 (120s)
//   10 ~ 20 分钟（凉区）：5 分钟 (300s)
//   20 ~ 30 分钟（余温）：10 分钟 (600s)
//   30 分钟以上（稳态）：15 分钟 (900s)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, log, localIso } from './lib.mjs';

export const HEARTBEAT_TIERS = [
  { maxElapsedMin: 3, intervalSec: 60, zone: '热区 (1m)', zoneKey: 'hot' },
  { maxElapsedMin: 10, intervalSec: 120, zone: '温区 (2m)', zoneKey: 'warm' },
  { maxElapsedMin: 20, intervalSec: 300, zone: '凉区 (5m)', zoneKey: 'cool' },
  { maxElapsedMin: 30, intervalSec: 600, zone: '余温 (10m)', zoneKey: 'tepid' },
  { maxElapsedMin: Infinity, intervalSec: 900, zone: '稳态 (15m)', zoneKey: 'steady' },
];

export const DEFAULT_INTERVAL_SEC = 900;

export function heartbeatFile(dir = stateDir()) {
  return join(dir, 'heartbeat.json');
}

export function calculateTier(lastActiveAt, now = Date.now()) {
  if (!lastActiveAt) {
    return {
      intervalSec: DEFAULT_INTERVAL_SEC,
      zone: '稳态 (15m)',
      zoneKey: 'steady',
      elapsedMin: Infinity,
    };
  }
  const ts = typeof lastActiveAt === 'number' ? lastActiveAt : new Date(lastActiveAt).getTime();
  if (Number.isNaN(ts)) {
    return {
      intervalSec: DEFAULT_INTERVAL_SEC,
      zone: '稳态 (15m)',
      zoneKey: 'steady',
      elapsedMin: Infinity,
    };
  }
  const elapsedMs = Math.max(0, now - ts);
  const elapsedMin = elapsedMs / 60000;
  for (const tier of HEARTBEAT_TIERS) {
    if (elapsedMin < tier.maxElapsedMin) {
      return {
        intervalSec: tier.intervalSec,
        zone: tier.zone,
        zoneKey: tier.zoneKey,
        elapsedMin,
      };
    }
  }
  return {
    intervalSec: DEFAULT_INTERVAL_SEC,
    zone: '稳态 (15m)',
    zoneKey: 'steady',
    elapsedMin,
  };
}

export function readHeartbeat(customDir) {
  const dir = customDir || stateDir();
  const file = heartbeatFile(dir);
  if (!existsSync(file)) {
    return {
      lastActiveAt: null,
      nextRunAt: 0,
      currentIntervalSec: DEFAULT_INTERVAL_SEC,
      zone: '稳态 (15m)',
      zoneKey: 'steady',
      lastRunAt: null,
      boostReason: null,
      updatedAt: null,
    };
  }
  try {
    const raw = readFileSync(file, 'utf-8');
    const data = JSON.parse(raw);
    return {
      lastActiveAt: data.lastActiveAt || null,
      nextRunAt: Number(data.nextRunAt) || 0,
      currentIntervalSec: Number(data.currentIntervalSec) || DEFAULT_INTERVAL_SEC,
      zone: data.zone || '稳态 (15m)',
      zoneKey: data.zoneKey || 'steady',
      lastRunAt: data.lastRunAt || null,
      boostReason: data.boostReason || null,
      updatedAt: data.updatedAt || null,
    };
  } catch (e) {
    log('⚠ heartbeat.json 读取失败，使用默认稳态：', String((e && e.message) || e));
    return {
      lastActiveAt: null,
      nextRunAt: 0,
      currentIntervalSec: DEFAULT_INTERVAL_SEC,
      zone: '稳态 (15m)',
      zoneKey: 'steady',
      lastRunAt: null,
      boostReason: null,
      updatedAt: null,
    };
  }
}

export function saveHeartbeat(state, customDir) {
  const dir = customDir || stateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(heartbeatFile(dir), JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

export function boostHeartbeat({ reason = '', now = Date.now(), stateDir: customDir } = {}) {
  const dir = customDir || stateDir();
  const activeIso = localIso(new Date(now));
  const tier = calculateTier(now, now);
  const state = {
    lastActiveAt: activeIso,
    nextRunAt: now, // 立即准备就绪
    currentIntervalSec: tier.intervalSec,
    zone: tier.zone,
    zoneKey: tier.zoneKey,
    lastRunAt: null,
    boostReason: reason,
    updatedAt: activeIso,
  };
  saveHeartbeat(state, dir);
  log(`[heartbeat] 心跳加速已激活 (${tier.zone})${reason ? '：' + reason : ''}`);
  return state;
}

export function isDue({ now = Date.now(), stateDir: customDir } = {}) {
  const state = readHeartbeat(customDir);
  return now >= (state.nextRunAt || 0);
}

export function recordRun({ now = Date.now(), stateDir: customDir } = {}) {
  const dir = customDir || stateDir();
  const prev = readHeartbeat(dir);
  const tier = calculateTier(prev.lastActiveAt, now);
  const runIso = localIso(new Date(now));
  const nextRunAt = now + tier.intervalSec * 1000;
  const state = {
    ...prev,
    nextRunAt,
    currentIntervalSec: tier.intervalSec,
    zone: tier.zone,
    zoneKey: tier.zoneKey,
    lastRunAt: runIso,
    updatedAt: runIso,
  };
  saveHeartbeat(state, dir);
  return state;
}

export function formatStatus(state = readHeartbeat()) {
  const tier = calculateTier(state.lastActiveAt);
  const elapsed = Number.isFinite(tier.elapsedMin)
    ? `${Math.round(tier.elapsedMin)} 分钟前`
    : '无近期互动';
  const nextInSec = Math.max(0, Math.round(((state.nextRunAt || 0) - Date.now()) / 1000));
  const nextStr = nextInSec === 0 ? '随时就绪' : `${nextInSec} 秒后`;
  return `${tier.zone}（距上次互动 ${elapsed}，下次拉取：${nextStr}）`;
}
