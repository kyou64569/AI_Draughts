/**
 * 运行时配置：端口、数据目录、SSE 心跳、LLM 超时/最小间隔。
 * 默认值来自 constants.js，可用环境变量覆盖。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LLM_CONNECT_TIMEOUT_MS,
  LLM_TIMEOUT_MS,
  MIN_LLM_INTERVAL_MS,
  PROVIDER_PROBE_TIMEOUT_MS,
  SSE_HEARTBEAT_MS,
} from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const SRC_DIR = path.dirname(__filename);

/** server/ 根目录 */
export const SERVER_ROOT = path.resolve(SRC_DIR, '..');

/**
 * 读取整数环境变量。
 * @param {string} name 环境变量名
 * @param {number} fallback 默认值
 * @returns {number}
 */
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 解析 CORS_ORIGIN：`*` → true（放行全部）；逗号分隔 → 数组。
 * @returns {true|string[]}
 */
function parseCorsOrigin() {
  const raw = (process.env.CORS_ORIGIN ?? '').trim();
  if (raw === '' || raw === '*') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 全局配置对象（只读语义，勿在运行期修改）。 */
export const config = Object.freeze({
  port: intEnv('PORT', 3001),
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(SERVER_ROOT, 'data'),
  corsOrigin: parseCorsOrigin(),
  sseHeartbeatMs: intEnv('SSE_HEARTBEAT_MS', SSE_HEARTBEAT_MS),
  llmConnectTimeoutMs: intEnv('LLM_CONNECT_TIMEOUT_MS', LLM_CONNECT_TIMEOUT_MS),
  llmTimeoutMs: intEnv('LLM_TIMEOUT_MS', LLM_TIMEOUT_MS),
  minLlmIntervalMs: intEnv('MIN_LLM_INTERVAL_MS', MIN_LLM_INTERVAL_MS),
  providerProbeTimeoutMs: intEnv('PROVIDER_PROBE_TIMEOUT_MS', PROVIDER_PROBE_TIMEOUT_MS),
});

export default config;
