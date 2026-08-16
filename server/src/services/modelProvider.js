/**
 * LLM 提供方适配层（OpenAI 兼容协议）。
 *
 * - 所有第三方调用只在服务端发生，API Key 永不出现在响应中（P0-5）；
 * - 30s 超时（决策 4）、同一 baseUrl ≥800ms 最小间隔（决策 5）；
 * - Node 22 全局 fetch，无额外依赖。
 */
import config from '../config.js';
import { THINKING_TO_EFFORT } from '../constants.js';

/** @type {Map<string, number>} baseUrl → 上一次调用时间戳（ms）。 */
const lastCallAt = new Map();
/** @type {Map<string, Promise<void>>} baseUrl → 串行链，保证并发调用方依次等待。 */
const inflight = new Map();

/**
 * 睡眠。
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 规范化 API 基址：
 * - 去掉末尾 `/`；
 * - 若已包含版本段（如 `.../v1`）则直接使用，否则补 `/v1`。
 * 这样 `https://api.openai.com/v1` 与 `https://api.openai.com` 两种写法都能正确工作。
 * @param {string} baseUrl
 * @returns {string}
 */
export function normalizeApiBase(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('baseUrl 为空');
  return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * 拼接接口路径。
 * @param {string} baseUrl
 * @param {string} pathname 形如 `/chat/completions`
 * @returns {string}
 */
export function buildUrl(baseUrl, pathname) {
  return `${normalizeApiBase(baseUrl)}${pathname}`;
}

/**
 * 清洗错误文本，避免任何情况下把 apiKey 回传给客户端。
 * @param {unknown} err
 * @param {string} [apiKey]
 * @returns {string}
 */
export function sanitizeError(err, apiKey = '') {
  let msg = '';
  if (err instanceof Error) msg = err.message || err.name;
  else msg = String(err ?? '未知错误');
  if (apiKey && apiKey.length >= 6) {
    msg = msg.split(apiKey).join('***');
  }
  return msg.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***').slice(0, 500);
}

/**
 * 同一 baseUrl 的最小调用间隔（防限流，决策 5）。
 *
 * 并发安全：多个调用方（多个房间同时进入 AI 回合、共享同一 baseUrl）会同时进入。
 * 此前「先读 lastCallAt、再 await sleep、最后才 set」会让并发调用方都读到同一个
 * 旧时间戳、算出重叠的 wait 并几乎同时发起请求——最小间隔被并发击穿。
 * 现用每 baseUrl 一条串行 promise 链：调用方依次排队，前一个完成 sleep 并更新
 * 时间戳后，后一个才据此计算自己的 wait，从而真正保证相邻两次发起 ≥ minLlmIntervalMs。
 * @param {string} baseUrl
 * @returns {Promise<void>}
 */
export async function enforceMinInterval(baseUrl) {
  const k = normalizeApiBase(baseUrl);
  const prev = inflight.get(k) ?? Promise.resolve();
  const next = prev.then(async () => {
    const last = lastCallAt.get(k) ?? 0;
    const wait = config.minLlmIntervalMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    lastCallAt.set(k, Date.now());
  });
  // 链上存"已捕获"的哨兵，避免单次失败让后续所有调用方断链；调用方 await 的是 next 本身。
  inflight.set(
    k,
    next.then(
      () => {},
      () => {},
    ),
  );
  await next;
}

/**
 * 带分段超时的 fetch：
 *  ① 连接阶段（建立请求直到拿到响应头）→ connectTimeoutMs，超时抛「连接超时」；
 *  ② 响应体读取阶段（模型思考与流式输出）→ timeoutMs，超时抛「响应超时（思考超时）」。
 * 两个阶段独立计时，便于区分"连不上"与"思考太久"。
 * @param {string} url
 * @param {RequestInit} options
 * @param {{connectTimeoutMs:number, timeoutMs:number}} timeouts
 * @returns {Promise<{text:string, res:Response}>}
 */
async function fetchWithTimeout(url, options, { connectTimeoutMs, timeoutMs }) {
  // ① 连接阶段：race 双保险——正常 fetch resolve，或超时 reject（并 abort 释放连接）。
  //    即使个别上游不响应 abort，也不会无限挂起。
  const ctrl = new AbortController();
  let connectTimer;
  const connectTimeoutPromise = new Promise((_, reject) => {
    connectTimer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`连接超时（${connectTimeoutMs}ms）`));
    }, connectTimeoutMs);
  });
  let res;
  try {
    res = await Promise.race([fetch(url, { ...options, signal: ctrl.signal }), connectTimeoutPromise]);
  } finally {
    clearTimeout(connectTimer);
  }

  // ② 响应体读取阶段（模型思考/输出）：race 保证即使 body 挂起也能超时返回
  const bodyPromise = res.text();
  let readTimer;
  const timeoutPromise = new Promise((_, reject) => {
    readTimer = setTimeout(() => reject(new Error(`响应超时（${timeoutMs}ms）`)), timeoutMs);
  });
  try {
    const text = await Promise.race([bodyPromise, timeoutPromise]);
    return { text, res };
  } finally {
    clearTimeout(readTimer);
  }
}

/**
 * 调用 Chat Completions（OpenAI 兼容）。
 * @param {{baseUrl:string, apiKey?:string}} cfg 模型配置（内部对象，含 apiKey）
 * @param {string} model 模型名
 * @param {Array<{role:string, content:string}>} messages 消息列表
 * @param {{timeoutMs?:number, connectTimeoutMs?:number, temperature?:number, maxTokens?:number, thinkingLevel?:string}} [options]
 * @returns {Promise<{content:string, latencyMs:number, finishReason:string|null, truncated:boolean, status:number}>}
 */
export async function callLLM(cfg, model, messages, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.llmTimeoutMs;
  const connectTimeoutMs = options.connectTimeoutMs ?? config.llmConnectTimeoutMs;
  const url = buildUrl(cfg.baseUrl, '/chat/completions');
  const body = {
    model,
    messages,
    // 低 temperature：减少同局面的随机抖动（决策稳定性，P0-3）
    temperature: options.temperature ?? 0.2,
    stream: false,
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  // 思考强度：OpenAI 兼容的 reasoning_effort 透传（default 不传，跟随模型默认）。
  // 若模型不支持该参数，调用将失败并走既有「严格重试→确定性兜底」，不影响对局。
  if (options.thinkingLevel && THINKING_TO_EFFORT[options.thinkingLevel]) {
    body.reasoning_effort = THINKING_TO_EFFORT[options.thinkingLevel];
  }

  const t0 = Date.now();
  const { text, res } = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    },
    { connectTimeoutMs, timeoutMs },
  );

  if (!res.ok) {
    throw new Error(`上游返回 ${res.status}: ${text.slice(0, 300)}`);
  }
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`上游响应非 JSON: ${text.slice(0, 200)}`);
  }
  const choice = json?.choices?.[0];
  const msg = choice?.message ?? {};
  // 推理模型兼容：不同服务商把思考/回答放在不同字段，而 content 可能为空
  // （如思考未完成被终止，或该模型只回思考不出最终答案）——按序回退读取，
  // 尝试从中解析走法。已覆盖：reasoning_content（DeepSeek）/ thinking（部分网关）/
  // reasoning（商汤 SenseNova）/ text（老式补全）。
  const content =
    typeof msg.content === 'string' && msg.content.trim() !== ''
      ? msg.content
      : (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim() !== ''
          ? msg.reasoning_content
          : (typeof msg.thinking === 'string' && msg.thinking.trim() !== ''
              ? msg.thinking
              : (typeof msg.reasoning === 'string' && msg.reasoning.trim() !== ''
                  ? msg.reasoning
                  : choice?.text ?? '')));
  if (typeof content !== 'string' || content.trim() === '') {
    // 诊断增强：附带响应片段，便于区分"网关格式不同"还是"限流降级空响应"
    throw new Error(`上游响应缺少 choices[0].message.content，响应片段: ${text.slice(0, 200)}`);
  }
  const finishReason = choice?.finish_reason ?? null;
  return {
    content,
    latencyMs: Date.now() - t0,
    finishReason,
    truncated: finishReason === 'length',
    status: res.status,
  };
}

/**
 * 拉取可用模型列表（后端代理 `GET {baseUrl}/models`）。
 * @param {{baseUrl:string, apiKey?:string}} cfg
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{models:string[], latencyMs:number}>}
 */
export async function listModels(cfg, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.providerProbeTimeoutMs;
  const url = buildUrl(cfg.baseUrl, '/models');
  const t0 = Date.now();
  const { text, res } = await fetchWithTimeout(
    url,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
    },
    // 探测场景：连接与响应共用同一短超时
    { connectTimeoutMs: timeoutMs, timeoutMs },
  );
  if (!res.ok) {
    throw new Error(`上游返回 ${res.status}: ${text.slice(0, 300)}`);
  }
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`上游响应非 JSON: ${text.slice(0, 200)}`);
  }
  const raw = Array.isArray(json) ? json : json?.data ?? json?.models ?? [];
  /** @type {string[]} */
  const models = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item === 'string') models.push(item);
    else if (item && typeof item.id === 'string') models.push(item.id);
    else if (item && typeof item.name === 'string') models.push(item.name);
  }
  return { models: [...new Set(models)].sort(), latencyMs: Date.now() - t0 };
}

/**
 * 连通性测试：拉一次模型列表，返回成功/失败 + 耗时（P0-1）。
 * @param {{baseUrl:string, apiKey?:string}} cfg
 * @returns {Promise<{ok:boolean, latencyMs:number, modelCount?:number, message?:string}>}
 */
export async function testConnection(cfg) {
  const t0 = Date.now();
  try {
    const { models } = await listModels(cfg);
    return { ok: true, latencyMs: Date.now() - t0, modelCount: models.length };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - t0,
      message: sanitizeError(err, cfg.apiKey ?? ''),
    };
  }
}

export default {
  normalizeApiBase,
  buildUrl,
  sanitizeError,
  enforceMinInterval,
  callLLM,
  listModels,
  testConnection,
};
