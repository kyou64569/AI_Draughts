/**
 * LLM 提供方适配层：统一封装 OpenAI 兼容 / Anthropic / Gemini 三种协议。
 *
 * - 所有第三方调用只在服务端发生，API Key 永不出现在响应中（P0-5）；
 * - 30s 超时（决策 4）、同一 baseUrl ≥800ms 最小间隔（决策 5）；
 * - Node 22 全局 fetch，无额外依赖；
 * - 三种协议均支持非流式与流式（SSE）调用；流式通过 onDelta 增量回调
 *   思考/正文片段，任何流式失败由调用方（llmDecision）退回非流式重试。
 *
 * provider 由模型配置的 `provider` 字段决定（缺省 'openai' 兼容旧数据）。
 */
import config from '../config.js';
import { LLM_PROVIDERS, THINKING_TO_EFFORT } from '../constants.js';

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
 * 规范化 provider 取值（未知/缺省 → openai 兼容旧数据）。
 * @param {any} provider
 * @returns {'openai'|'anthropic'|'gemini'}
 */
export function normalizeProvider(provider) {
  return LLM_PROVIDERS.includes(provider) ? provider : 'openai';
}

/**
 * 规范化 API 基址（OpenAI 兼容协议）：
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
 * 基址规范化（仅去尾斜杠；anthropic/gemini 的版本段写在接口路径里）。
 * @param {string} baseUrl
 * @returns {string}
 */
function trimBase(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (trimmed === '') throw new Error('baseUrl 为空');
  return trimmed;
}

/**
 * 拼接接口路径（OpenAI 兼容协议）。
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
  const k = trimBase(baseUrl);
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

/* ------------------------------------------------------------------ *
 * 请求体构建（纯函数，供单测）
 * ------------------------------------------------------------------ */

/**
 * 拆分 messages → 各协议需要的 system 文本与对话消息。
 * @param {Array<{role:string, content:string}>} messages
 * @returns {{systemText: string, chats: Array<{role:string, content:string}>}}
 */
export function splitMessages(messages) {
  const systemText = (messages ?? [])
    .filter((m) => m?.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n');
  const chats = (messages ?? [])
    .filter((m) => m?.role !== 'system' && typeof m.content === 'string')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  return { systemText, chats };
}

/**
 * 构建 OpenAI 兼容 /chat/completions 请求体。
 * @param {string} model
 * @param {Array<{role:string, content:string}>} messages
 * @param {{maxTokens?:number, thinkingLevel?:string|null, stream?:boolean}} options
 * @returns {object}
 */
export function buildOpenAIBody(model, messages, options = {}) {
  const body = {
    model,
    messages,
    // 低 temperature：减少同局面的随机抖动（决策稳定性，P0-3）
    temperature: 0.2,
    stream: Boolean(options.stream),
  };
  if (options.maxTokens) body.max_tokens = options.maxTokens;
  // 思考强度：OpenAI 兼容的 reasoning_effort 透传（default 不传，跟随模型默认）。
  // 若模型不支持该参数，调用将失败并走既有「严格重试→确定性兜底」，不影响对局。
  if (options.thinkingLevel && THINKING_TO_EFFORT[options.thinkingLevel]) {
    body.reasoning_effort = THINKING_TO_EFFORT[options.thinkingLevel];
  }
  if (options.stream) body.stream_options = { include_usage: true };
  return body;
}

/**
 * 构建 Anthropic /v1/messages 请求体（max_tokens 为必填；思考强度暂不透传）。
 */
export function buildAnthropicBody(model, messages, options = {}) {
  const { systemText, chats } = splitMessages(messages);
  return {
    model,
    max_tokens: options.maxTokens ?? 2048,
    temperature: 0.2,
    ...(systemText ? { system: systemText } : {}),
    messages: chats,
    stream: Boolean(options.stream),
  };
}

/**
 * 构建 Gemini :generateContent 请求体（system → systemInstruction；assistant → model 角色）。
 */
export function buildGeminiBody(model, messages, options = {}) {
  const { systemText, chats } = splitMessages(messages);
  return {
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
    contents: chats.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: options.maxTokens ?? 2048,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 响应解析（纯函数，供单测）
 * ------------------------------------------------------------------ */

/** 判定是否截断（各协议 finish 取值不同）。 */
function isTruncated(provider, finishReason) {
  if (provider === 'anthropic') return finishReason === 'max_tokens';
  if (provider === 'gemini') return finishReason === 'MAX_TOKENS';
  return finishReason === 'length';
}

/** 从 OpenAI 兼容响应提取文本（含推理模型多字段回退链）。 */
export function parseOpenAIResponse(json) {
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
  const finishReason = choice?.finish_reason ?? null;
  const usage = json?.usage ?? null;
  return {
    content,
    finishReason,
    truncated: finishReason === 'length',
    usage:
      usage && Number.isFinite(usage.prompt_tokens) && Number.isFinite(usage.completion_tokens)
        ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }
        : null,
  };
}

/** 从 Anthropic 响应提取文本（text 块优先，空则回退 thinking 块）。 */
export function parseAnthropicResponse(json) {
  const blocks = Array.isArray(json?.content) ? json.content : [];
  const join = (arr, field) => arr.map((p) => p?.[field]).filter((t) => typeof t === 'string').join('');
  const text = join(blocks.filter((p) => p?.type === 'text'), 'text');
  const fallback = text.trim() !== '' ? text : join(blocks.filter((p) => p?.type === 'thinking'), 'thinking');
  const finishReason = json?.stop_reason ?? null;
  const usage = json?.usage ?? null;
  return {
    content: fallback,
    finishReason,
    truncated: finishReason === 'max_tokens',
    usage:
      usage && Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
        ? { promptTokens: usage.input_tokens, completionTokens: usage.output_tokens }
        : null,
  };
}

/** 从 Gemini 响应提取文本（thought 摘要块仅作回退）。 */
export function parseGeminiResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => typeof p?.text === 'string' && p.thought !== true).map((p) => p.text).join('');
  const fallback =
    text.trim() !== ''
      ? text
      : parts.filter((p) => typeof p?.text === 'string' && p.thought === true).map((p) => p.text).join('');
  const finishReason = json?.candidates?.[0]?.finishReason ?? null;
  const usage = json?.usageMetadata ?? null;
  return {
    content: fallback,
    finishReason,
    truncated: finishReason === 'MAX_TOKENS',
    usage:
      usage && Number.isFinite(usage.promptTokenCount) && Number.isFinite(usage.candidatesTokenCount)
        ? { promptTokens: usage.promptTokenCount, completionTokens: usage.candidatesTokenCount }
        : null,
  };
}

/**
 * 创建上游 SSE 流解析器（三协议共用行级解析，供单测）。
 * feed 收到任意分段文本（自动处理跨 chunk 断行），result 返回累积结果。
 * @param {'openai'|'anthropic'|'gemini'} provider
 * @param {({kind:'thinking'|'content', text:string})=>void} [onDelta]
 */
export function createStreamParser(provider, onDelta) {
  const state = { buffer: '', content: '', reasoning: '', usage: null, finishReason: null };
  const emit = (kind, text) => {
    if (text && typeof onDelta === 'function') onDelta({ kind, text });
  };

  const handleData = (json) => {
    if (provider === 'anthropic') {
      if (json?.type === 'message_start') {
        const u = json?.message?.usage;
        if (u && Number.isFinite(u.input_tokens)) {
          state.usage = { promptTokens: u.input_tokens, completionTokens: u.output_tokens ?? 0 };
        }
      } else if (json?.type === 'content_block_delta') {
        const d = json?.delta ?? {};
        if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
          state.reasoning += d.thinking;
          emit('thinking', d.thinking);
        } else if (d.type === 'text_delta' && typeof d.text === 'string') {
          state.content += d.text;
          emit('content', d.text);
        }
      } else if (json?.type === 'message_delta') {
        if (json?.delta?.stop_reason) state.finishReason = json.delta.stop_reason;
        if (json?.usage && Number.isFinite(json.usage.output_tokens) && state.usage) {
          state.usage = { ...state.usage, completionTokens: json.usage.output_tokens };
        }
      } else if (json?.type === 'error') {
        throw new Error(`上游流式返回错误: ${json?.error?.message ?? 'unknown'}`);
      }
      return;
    }
    if (provider === 'gemini') {
      const cand = json?.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (typeof part?.text !== 'string') continue;
        if (part.thought === true) {
          state.reasoning += part.text;
          emit('thinking', part.text);
        } else {
          state.content += part.text;
          emit('content', part.text);
        }
      }
      if (cand?.finishReason) state.finishReason = cand.finishReason;
      const u = json?.usageMetadata;
      if (u && Number.isFinite(u.promptTokenCount)) {
        state.usage = { promptTokens: u.promptTokenCount, completionTokens: u.candidatesTokenCount ?? 0 };
      }
      return;
    }
    // openai 兼容
    const choice = json?.choices?.[0];
    const delta = choice?.delta ?? {};
    // 思考字段与 parseOpenAIResponse 的回退链保持一致（reasoning_content/thinking/reasoning），
    // 不同网关放在不同字段；只认非流式分支已支持的字段，避免误收正文。
    for (const field of ['reasoning_content', 'thinking', 'reasoning']) {
      const t = delta[field];
      if (typeof t === 'string' && t !== '') {
        state.reasoning += t;
        emit('thinking', t);
      }
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      state.content += delta.content;
      emit('content', delta.content);
    }
    if (choice?.finish_reason) state.finishReason = choice.finish_reason;
    const u = json?.usage;
    if (u && Number.isFinite(u.prompt_tokens)) {
      state.usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens ?? 0 };
    }
  };

  return {
    /** @param {string} chunk 任意分段文本 */
    push(chunk) {
      state.buffer += chunk;
      let idx;
      while ((idx = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, idx).replace(/\r$/, '');
        state.buffer = state.buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '' || payload === '[DONE]') continue;
        try {
          handleData(JSON.parse(payload));
        } catch (err) {
          // 协议内显式错误向上抛；其余（非 JSON 行/字段抖动）忽略保证流不断
          if (String(err?.message ?? '').startsWith('上游流式返回错误')) throw err;
        }
      }
    },
    /** 流结束后取累积结果。 */
    result() {
      return {
        content: state.content,
        reasoning: state.reasoning,
        usage: state.usage,
        finishReason: state.finishReason,
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 带超时的 fetch
 * ------------------------------------------------------------------ */

/**
 * 带分段超时的 fetch（非流式）：
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
 * 带分段超时的流式 fetch：连接阶段同上；响应体经 reader 逐块交给 onChunk，
 * 整个读取阶段共享 timeoutMs 死线（超时 abort 并抛「响应超时」）。
 * @param {string} url
 * @param {RequestInit} options
 * @param {{connectTimeoutMs:number, timeoutMs:number}} timeouts
 * @param {(text:string)=>void} onChunk
 * @returns {Promise<{res:Response, head:string}>} head 为非 2xx 时截留的响应体开头
 *   （错误体不是 SSE 而是普通 JSON/文本；body 已被流式消费，无法再 text() 二次读取）。
 */
async function fetchStreamWithTimeout(url, options, { connectTimeoutMs, timeoutMs }, onChunk) {
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

  const HEAD_LIMIT = 4096;
  const captureHead = !res.ok;
  /** @type {string[]} */
  const headParts = [];
  let headLen = 0;
  const emit = (text) => {
    if (captureHead && headLen < HEAD_LIMIT) {
      const cut = text.slice(0, HEAD_LIMIT - headLen);
      headParts.push(cut);
      headLen += cut.length;
    }
    onChunk(text);
  };

  const reader = res.body?.getReader?.();
  if (!reader) {
    // 极少数运行时无流式 body：退化为整体读取
    const text = await res.text();
    emit(text);
    return { res, head: headParts.join('') };
  }
  const decoder = new TextDecoder();
  let deadline;
  const deadlinePromise = new Promise((_, reject) => {
    deadline = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`响应超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadlinePromise]);
      if (done) break;
      emit(decoder.decode(value, { stream: true }));
    }
    emit(decoder.decode());
    return { res, head: headParts.join('') };
  } finally {
    clearTimeout(deadline);
  }
}

/* ------------------------------------------------------------------ *
 * 协议端点与调用
 * ------------------------------------------------------------------ */

/**
 * 组装某 provider 的请求端点/头部/请求体。
 * @returns {{url:string, headers:object, body:object}}
 */
function buildRequest(provider, cfg, model, messages, options) {
  const key = cfg.apiKey ?? '';
  if (provider === 'anthropic') {
    const base = trimBase(cfg.baseUrl);
    return {
      url: `${base}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        'anthropic-version': '2023-06-01',
      },
      body: buildAnthropicBody(model, messages, options),
    };
  }
  if (provider === 'gemini') {
    const base = trimBase(cfg.baseUrl);
    const path = options.stream
      ? `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
      : `/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return {
      url: `${base}${path}`,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'x-goog-api-key': key } : {}),
      },
      body: buildGeminiBody(model, messages, options),
    };
  }
  // openai 兼容（缺省）
  return {
    url: buildUrl(cfg.baseUrl, '/chat/completions'),
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: buildOpenAIBody(model, messages, options),
  };
}

function parseResponse(provider, json) {
  if (provider === 'anthropic') return parseAnthropicResponse(json);
  if (provider === 'gemini') return parseGeminiResponse(json);
  return parseOpenAIResponse(json);
}

/**
 * 调用 Chat 接口（按 provider 分发）。
 * @param {{baseUrl:string, apiKey?:string, provider?:string}} cfg 模型配置（内部对象，含 apiKey）
 * @param {string} model 模型名
 * @param {Array<{role:string, content:string}>} messages 消息列表
 * @param {{timeoutMs?:number, connectTimeoutMs?:number, temperature?:number, maxTokens?:number, thinkingLevel?:string|null, stream?:boolean, onDelta?:Function}} [options]
 * @returns {Promise<{content:string, latencyMs:number, finishReason:string|null, truncated:boolean, status:number, usage:{promptTokens:number, completionTokens:number}|null}>}
 */
export async function callLLM(cfg, model, messages, options = {}) {
  const provider = normalizeProvider(cfg?.provider);
  const timeoutMs = options.timeoutMs ?? config.llmTimeoutMs;
  const connectTimeoutMs = options.connectTimeoutMs ?? config.llmConnectTimeoutMs;
  const { url, headers, body } = buildRequest(provider, cfg, model, messages, options);

  const t0 = Date.now();

  if (options.stream && typeof options.onDelta === 'function') {
    const parser = createStreamParser(provider, options.onDelta);
    const { res, head } = await fetchStreamWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      { connectTimeoutMs, timeoutMs },
      (chunk) => parser.push(chunk),
    );
    if (!res.ok) {
      const err = new Error(`上游返回 ${res.status}: ${head.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const r = parser.result();
    // 正文为空时回退思考文本（推理模型可能只回思考；extractJson 仍可从中解析）
    const content = r.content.trim() !== '' ? r.content : r.reasoning;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('上游流式响应未返回任何文本内容');
    }
    return {
      content,
      latencyMs: Date.now() - t0,
      finishReason: r.finishReason,
      truncated: isTruncated(provider, r.finishReason),
      status: res.status,
      usage: r.usage,
    };
  }

  const { text, res } = await fetchWithTimeout(
    url,
    { method: 'POST', headers, body: JSON.stringify(body) },
    { connectTimeoutMs, timeoutMs },
  );

  if (!res.ok) {
    const err = new Error(`上游返回 ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  /** @type {any} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // nonJson 标记：调用方可据此对流式调用退回非流式重试（部分网关不支持 SSE）
    const err = new Error(`上游响应非 JSON: ${text.slice(0, 200)}`);
    err.nonJson = true;
    throw err;
  }
  const parsed = parseResponse(provider, json);
  if (typeof parsed.content !== 'string' || parsed.content.trim() === '') {
    // 诊断增强：附带响应片段，便于区分"网关格式不同"还是"限流降级空响应"
    throw new Error(`上游响应缺少内容字段，响应片段: ${text.slice(0, 200)}`);
  }
  return {
    content: parsed.content,
    latencyMs: Date.now() - t0,
    finishReason: parsed.finishReason,
    truncated: parsed.truncated,
    status: res.status,
    usage: parsed.usage,
  };
}

/**
 * 拉取可用模型列表（按 provider 分发；后端代理，Key 不外泄）。
 * @param {{baseUrl:string, apiKey?:string, provider?:string}} cfg
 * @param {{timeoutMs?:number}} [options]
 * @returns {Promise<{models:string[], latencyMs:number}>}
 */
export async function listModels(cfg, options = {}) {
  const provider = normalizeProvider(cfg?.provider);
  const timeoutMs = options.timeoutMs ?? config.providerProbeTimeoutMs;
  const key = cfg.apiKey ?? '';
  const t0 = Date.now();

  /** @type {{url:string, headers:object, pick:(json:any)=>string[]}} */
  let spec;
  if (provider === 'anthropic') {
    spec = {
      url: `${trimBase(cfg.baseUrl)}/v1/models`,
      headers: {
        Accept: 'application/json',
        ...(key ? { 'x-api-key': key } : {}),
        'anthropic-version': '2023-06-01',
      },
      pick: (json) =>
        (Array.isArray(json?.data) ? json.data : [])
          .map((m) => (typeof m?.id === 'string' ? m.id : ''))
          .filter(Boolean),
    };
  } else if (provider === 'gemini') {
    spec = {
      url: `${trimBase(cfg.baseUrl)}/v1beta/models`,
      headers: { Accept: 'application/json', ...(key ? { 'x-goog-api-key': key } : {}) },
      pick: (json) =>
        (Array.isArray(json?.models) ? json.models : [])
          .filter(
            (m) =>
              !Array.isArray(m?.supportedGenerationMethods) ||
              m.supportedGenerationMethods.includes('generateContent'),
          )
          .map((m) => (typeof m?.name === 'string' ? m.name.replace(/^models\//, '') : ''))
          .filter(Boolean),
    };
  } else {
    spec = {
      url: buildUrl(cfg.baseUrl, '/models'),
      headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      pick: (json) => {
        const raw = Array.isArray(json) ? json : json?.data ?? json?.models ?? [];
        /** @type {string[]} */
        const models = [];
        for (const item of Array.isArray(raw) ? raw : []) {
          if (typeof item === 'string') models.push(item);
          else if (item && typeof item.id === 'string') models.push(item.id);
          else if (item && typeof item.name === 'string') models.push(item.name);
        }
        return models;
      },
    };
  }

  const { text, res } = await fetchWithTimeout(
    spec.url,
    { method: 'GET', headers: spec.headers },
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
  const models = spec.pick(json);
  return { models: [...new Set(models)].sort(), latencyMs: Date.now() - t0 };
}

/**
 * 连通性测试：拉一次模型列表，返回成功/失败 + 耗时（P0-1）。
 * @param {{baseUrl:string, apiKey?:string, provider?:string}} cfg
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
  normalizeProvider,
  normalizeApiBase,
  buildUrl,
  sanitizeError,
  enforceMinInterval,
  callLLM,
  listModels,
  testConnection,
};
