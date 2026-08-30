/**
 * AI 决策编排（P0-4、决策 4）：
 *  LLM 调用 → JSON 解析 → 合法性校验 → 更严格提示重试 1 次 → 确定性兜底；
 *  同一座位连续 3 次失败 → 标记 auto-pilot，此后不再调用 LLM。
 */
import { LLM_MAX_TOKENS_BY_THINKING, LLM_STRICT_RETRY } from '../constants.js';
import { TARGET_CELLS, cubeDistance } from '../engine/board.js';
import {
  findMoveByEndpoints,
  getAllLegalMoves,
  getLegalMoves,
  isJump,
  ownPieces,
} from '../engine/rules.js';
import {
  isAutoPilot,
  markAutoPilotRetry,
  registerFailure,
  resetFailure,
  shouldRetryAutoPilot,
  unmarkAutoPilot,
} from '../engine/game.js';
import store from '../store.js';
import { callLLM, enforceMinInterval, sanitizeError } from './modelProvider.js';
import { buildPrompt } from './promptBuilder.js';

/**
 * @typedef {object} Decision
 * @property {string[]|null} path 走法路径；skip 时为 null
 * @property {boolean} [skip] 是否跳过该回合
 * @property {object} log LogEntry（未落库）
 */

/**
 * 解析 AI 玩家 → 模型配置（含 apiKey，仅服务端使用）。
 * @param {object} player GameState.players[seat]
 * @returns {Promise<{cfg: object|null, model: string|null, aiPlayerName: string|null, promptStyle: string|null, error: string|null}>}
 */
export async function resolveModelConfig(player) {
  if (!player?.aiPlayerId) {
    return { cfg: null, model: null, aiPlayerName: null, promptStyle: null, error: '座位未绑定 AI 玩家' };
  }
  const aiPlayer = await store.findById('aiPlayers', player.aiPlayerId);
  if (!aiPlayer) {
    return {
      cfg: null,
      model: null,
      aiPlayerName: null,
      promptStyle: null,
      error: 'AI 玩家已被删除',
    };
  }
  const cfg = await store.findById('modelConfigs', aiPlayer.modelConfigId);
  if (!cfg) {
    return {
      cfg: null,
      model: aiPlayer.model,
      aiPlayerName: aiPlayer.name,
      promptStyle: aiPlayer.promptStyle ?? null,
      error: '模型配置已被删除',
    };
  }
  return {
    cfg,
    model: aiPlayer.model,
    aiPlayerName: aiPlayer.name,
    promptStyle: aiPlayer.promptStyle ?? null,
    error: null,
  };
}

/**
 * 从模型回复中提取 JSON 对象（容忍 ```json 包裹与前后缀文字）。
 * @param {string} content
 * @returns {object|null}
 */
export function extractJson(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  // 去掉 Markdown 代码块围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // 直接尝试
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* 继续尝试截取 */
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 把 `{q,r,s}` 或 `"q,r,s"` 归一化为坐标键。
 * @param {any} value
 * @returns {string|null}
 */
export function toCoordKey(value) {
  if (typeof value === 'string') {
    const parts = value.split(',').map((x) => Number(String(x).trim()));
    if (parts.length === 3 && parts.every((n) => Number.isInteger(n))) return parts.join(',');
    return null;
  }
  if (value && typeof value === 'object') {
    const q = Number(value.q);
    const r = Number(value.r);
    const s = value.s === undefined ? -q - r : Number(value.s);
    if ([q, r, s].every((n) => Number.isInteger(n)) && q + r + s === 0) return `${q},${r},${s}`;
  }
  return null;
}

/**
 * 校验模型给出的走法是否合法，并返回完整 path。
 * @param {object} state GameState
 * @param {number} seat
 * @param {object} parsed 解析后的 JSON
 * @returns {{path: string[]|null, error: string|null}}
 */
export function matchLegalMove(state, seat, parsed) {
  const color = state.players[seat].color;
  const from = toCoordKey(parsed?.from);
  const to = toCoordKey(parsed?.to);
  if (!from || !to) return { path: null, error: 'from/to 坐标缺失或格式非法' };
  if (state.board[from] === undefined) return { path: null, error: `from ${from} 不在棋盘上` };
  if (state.board[to] === undefined) return { path: null, error: `to ${to} 不在棋盘上` };
  if (state.board[from] !== color) {
    return { path: null, error: `from ${from} 不是你的棋子（当前为 ${state.board[from] ?? '空'}）` };
  }
  const path = findMoveByEndpoints(state.board, from, to);
  if (!path) return { path: null, error: `${from} -> ${to} 不是合法走法` };
  return { path, error: null };
}

/**
 * 计算某坐标到"仍空缺的目标营地格"的最小立方距离（兜底推进指标）。
 * @param {Record<string, string|null>} board
 * @param {string} coordKey
 * @param {'red'|'green'|'blue'} color
 * @returns {number}
 */
export function distanceToTargetHole(board, coordKey, color) {
  const cells = TARGET_CELLS[color];
  let best = Number.POSITIVE_INFINITY;
  for (const cell of cells) {
    if (board[cell] === color && cell !== coordKey) continue; // 已被自己占住的格不再作为目标
    const d = cubeDistance(coordKey, cell);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * 目标营地补位计划（决策 4 兜底算法 + prompt 收益标注的核心，见 engine/fillPlan.js）：
 *   中国跳棋营地必须由深到浅填充；每回合只开放一个落位点 nextHole（最深的空格），
 *   已就位棋子（settled，营地深前缀）冻结，从而保持前缀不变量、避免来回抖动。
 */
import {
  computeFillPlan,
  findCampBlockedForeigners,
  findUnblockMove,
  isUnblockMove,
} from '../engine/fillPlan.js';
export { computeFillPlan } from '../engine/fillPlan.js';

/**
 * 确定性兜底走法（决策 4）：
 *  连跳与单步统一按"推进收益"最大化选取（收益 = 到 nextHole 的立方距离减少量）；
 *  连跳次数多不代表收益大——绕远路的连跳可能收益很小甚至为负，应与单步公平比较；
 *  等价取第一个；无任何合法走法 → skip turn。
 *
 * 推进收益 = 到当前落位点 `nextHole` 的立方距离减少量（见 computeFillPlan）。
 * 两处必要细化（否则对局不收敛，实测会永远卡在 7/10 或原地抖动）：
 *  - 已就位棋子冻结、且禁止落在除 `nextHole` 以外的营地格，保证营地由深到浅填满；
 *  - 不立刻走与上一手严格逆向的回头路（防原地往返）。
 *
 * @param {object} state GameState
 * @param {number} seat
 * @param {string|null} [model] 用于日志展示的模型名
 * @param {string} [note] 兜底原因描述
 * @returns {Decision}
 */
export function fallbackMove(state, seat, model = null, note = '兜底') {
  const player = state.players[seat];
  const color = player.color;
  const board = state.board;

  // 该座位上一手（用于避免原地往复）
  let lastOwnMove = null;
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    if (state.history[i].seat === seat) {
      lastOwnMove = state.history[i];
      break;
    }
  }

  /** @type {string[][]} */
  const pool = [];
  for (const from of ownPieces(board, color)) {
    for (const path of getLegalMoves(board, from)) pool.push(path);
  }
  if (pool.length === 0) {
    return {
      path: null,
      skip: true,
      log: {
        seat,
        model,
        thinking: '',
        reason: `${note}：无任何合法走法，跳过回合`,
        from: null,
        to: null,
        isFallback: true,
      },
    };
  }

  const { nextHole, settled } = computeFillPlan(board, color);

  // 让位（大本营堵死僵局解法）：外族棋子困在我方目标营地内无法脱身时，
  // 优先挪开挡路的己方营地棋子为其让出出口（规则引擎允许移出营地，此处
  // 临时豁免 settled 冻结；被困棋子离开后，本方棋子会被 fillPlan 的
  // nextHole 收益正常引导移回）。
  const blockedForeigners = findCampBlockedForeigners(board, color);
  if (blockedForeigners.length > 0) {
    const unblock = findUnblockMove(board, color, blockedForeigners);
    if (unblock) {
      const p = unblock.path;
      const kind = isJump(p) ? `连跳x${p.length - 1}` : '单步';
      return {
        path: p,
        log: {
          seat,
          model,
          thinking: '',
          reason: `${note}：让位——外族棋子被困于我方营地（${blockedForeigners.join('、')}），挪开 ${kind} ${p[0]} -> ${p[p.length - 1]} 为其让路`,
          from: p[0],
          to: p[p.length - 1],
          isFallback: true,
        },
      };
    }
  }

  // 确定性兜底：保守的"当前收益最大化"（安全网，保持高效收敛）。
  // 铺路前瞻（未来收益）只用于 LLM 主路径的候选标注；兜底若也前瞻，
  // 会陷入"不停搭桥不前进"的低效（实测纯兜底完局 226 手 → 1999 手）。
  /** @type {{path:string[], gain:number}|null} */
  let best = null;
  for (const path of pool) {
    const from = path[0];
    const to = path[path.length - 1];
    if (
      lastOwnMove &&
      lastOwnMove.from === to &&
      lastOwnMove.to === from &&
      pool.length > 1
    ) {
      continue; // 不立刻走回头路
    }
    let gain = cubeDistance(from, nextHole) - cubeDistance(to, nextHole);
    if (to === nextHole) gain += 2; // 精确落位加成
    if (settled.has(from)) gain -= 100; // 已就位棋子冻结（维持"由深到浅"前缀不变量）
    if (best == null || gain > best.gain) best = { path, gain };
  }

  const chosen = best ?? { path: pool[0], gain: 0 };

  const path = chosen.path;
  const kind = isJump(path) ? `连跳x${path.length - 1}` : '单步';
  return {
    path,
    log: {
      seat,
      model,
      thinking: '',
      reason: `${note}：确定性算法选择 ${kind} ${path[0]} -> ${path[path.length - 1]}（推进收益 ${chosen.gain}）`,
      from: path[0],
      to: path[path.length - 1],
      isFallback: true,
    },
  };
}

/**
 * 公共 sanity 校验（决策合理性，区别于规则合法性）：
 *  ① 禁止与上一手严格逆向（"跳过去又跳回来"的原地往返）；
 *  ② 禁止移动"已就位"棋子（computeFillPlan 冻结的营地深前缀，维持"由深到浅"填充不变量）。
 * 接入 LLM 主路径：被拒走法按"校验失败"处理 → 严格重试 1 次 → 确定性兜底。
 * @param {object} state GameState
 * @param {number} seat 座位号
 * @param {string[]} path 已通过规则校验的走法
 * @returns {{ok: boolean, error: string|null}}
 */
export function sanityCheck(state, seat, path) {
  const color = state.players[seat].color;
  const from = path[0];
  const to = path[path.length - 1];

  // ① 防原地往返：与上一手完全反向
  let lastOwn = null;
  for (let i = state.history.length - 1; i >= 0; i -= 1) {
    if (state.history[i].seat === seat) {
      lastOwn = state.history[i];
      break;
    }
  }
  if (lastOwn && lastOwn.from === to && lastOwn.to === from) {
    return {
      ok: false,
      error: `禁止立即走回上一手起点（上一手 ${lastOwn.from} -> ${lastOwn.to}，违反防原地往返约束）`,
    };
  }

  // ② 已就位棋子冻结：不能移动营地深前缀的己方棋子。
  //    例外（让位）：外族棋子困于我方营地且此走法确实能让它脱困时，
  //    允许临时移出（与 fallbackMove 的让位分支、prompt 的条件硬约束一致）。
  const { settled } = computeFillPlan(state.board, color);
  if (settled.has(from) && !isUnblockMove(state.board, color, path)) {
    return {
      ok: false,
      error: `${from} 已就位于目标营地（由深到浅填充不变量，冻结），禁止移动`,
    };
  }

  return { ok: true, error: null };
}

/**
 * 决策入口：为某个 AI 座位产出一手走法。
 * @param {object} state GameState
 * @param {number} seat 座位号
 * @param {{onThinking?: ({kind:'thinking'|'content', text:string})=>void}} [options]
 *   onThinking：流式增量回调（思考/正文片段），由调度器节流后经 SSE 推送前端。
 * @returns {Promise<Decision>}
 */
export async function decideMove(state, seat, options = {}) {
  const player = state.players[seat];
  const onThinking = typeof options.onThinking === 'function' ? options.onThinking : undefined;

  // 无合法走法 → 直接 skip
  if (getAllLegalMoves(state.board, player.color).length === 0) {
    return fallbackMove(state, seat, player.model, '系统');
  }

  // 托管恢复：默认不再调用 LLM；每隔 AUTO_PILOT_RETRY_INTERVAL_PLIES 手重试一次
  // 真实决策——临时故障（限流窗口/网络抖动/模型偶发异常）可自愈，成功即移出托管；
  // 永久性故障（配置失效等）下每 N 手一次重试的代价可忽略。重试无论成败都会
  // 重置计时（markAutoPilotRetry），保证失败后不会每手都打 LLM。
  const inAutoPilot = isAutoPilot(state, seat);
  if (inAutoPilot) {
    if (!shouldRetryAutoPilot(state, seat)) {
      return fallbackMove(state, seat, player.model, '托管(auto-pilot)');
    }
    markAutoPilotRetry(state, seat);
  }

  const { cfg, model, promptStyle, error } = await resolveModelConfig(player);
  if (error || !cfg || !model) {
    const res = registerFailure(state, seat);
    return fallbackMove(
      state,
      seat,
      model ?? player.model,
      `配置不可用(${error})${res.autoPilot ? '，已转入托管' : ''}`,
    );
  }

  /** @type {string[]} */
  const failures = [];

  /**
   * 单次 LLM 尝试：调用 → 解析 → 合法性 → sanity。
   * 默认走流式（实时推送思考片段）；若上游返回 4xx 或非 JSON（部分网关不支持
   * SSE/流式参数），自动退回非流式重试一次；两者都失败才计为本次尝试失败。
   * @param {object[]} messages
   * @param {string|null} thinkingLevel null=不传思考参数（降级模式）
   * @returns {Promise<{ok:true, path:string[], latencyMs:number, parsed:object, status:number, usage:object|null} | {ok:false, fail:string, status:number}>}
   */
  const tryOnce = async (messages, thinkingLevel) => {
    await enforceMinInterval(cfg.baseUrl);
    const callOpts = (useStream) => ({
      thinkingLevel,
      maxTokens: thinkingLevel
        ? LLM_MAX_TOKENS_BY_THINKING[thinkingLevel] ?? 2048
        : 2048,
      ...(useStream ? { stream: true, onDelta: onThinking } : {}),
    });
    /** @type {any} */
    let res;
    try {
      res = await callLLM(cfg, model, messages, callOpts(true));
    } catch (err) {
      // 流式不兼容（网关 4xx 拒绝 / 返回体非 JSON）→ 非流式兜底重试；
      // 超时等真实故障不重复消耗时间。callLLM 抛错时携带结构化
      // err.status（上游 HTTP 状态）与 err.nonJson（响应体无法解析）标记。
      const status = Number(err?.status);
      if ((Number.isFinite(status) && status >= 400 && status < 500) || Boolean(err?.nonJson)) {
        res = await callLLM(cfg, model, messages, callOpts(false));
      } else {
        throw err;
      }
    }
    const { content, latencyMs, truncated, status, usage } = res;
    const parsed = extractJson(content);
    if (!parsed) {
      return {
        ok: false,
        fail: `回复无法解析为 JSON${truncated ? '（输出达到 max_tokens 上限被截断）' : ''}`,
        status,
      };
    }
    const { path, error: matchError } = matchLegalMove(state, seat, parsed);
    if (!path) return { ok: false, fail: matchError, status };
    const sanity = sanityCheck(state, seat, path);
    if (!sanity.ok) return { ok: false, fail: sanity.error, status };
    return { ok: true, path, latencyMs, parsed, status, usage };
  };

  /** 成功返回决策（统一出口）。 */
  const succeed = (res, strict, degraded) => {
    resetFailure(state, seat);
    // 托管重试成功 → 移出托管，恢复正常 LLM 决策
    unmarkAutoPilot(state, seat);
    return {
      path: res.path,
      log: {
        seat,
        model,
        thinking: typeof res.parsed.thinking === 'string' ? res.parsed.thinking : '',
        reason:
          (typeof res.parsed.reason === 'string' && res.parsed.reason.trim() !== ''
            ? res.parsed.reason.trim()
            : '（模型未给出理由）') +
          `（${res.latencyMs}ms${strict ? '，严格重试' : ''}${degraded ? '，思考参数降级' : ''}${
            inAutoPilot ? '，托管恢复成功' : ''
          }）`,
        from: res.path[0],
        to: res.path[res.path.length - 1],
        isFallback: false,
        latencyMs: res.latencyMs,
        usage: res.usage ?? null,
        // 本次决策累计的失败尝试数（0 = 一次成功；重试成功也能如实计入质量统计）
        failures: failures.length,
      },
    };
  };

  for (let attempt = 0; attempt <= LLM_STRICT_RETRY; attempt += 1) {
    const strict = attempt > 0;
    const { messages } = buildPrompt(state, seat, { strict, customPrompt: promptStyle });
    const thinkingLevel = player.thinkingLevel ?? 'default';
    try {
      const res = await tryOnce(messages, thinkingLevel);
      if (!res.ok) {
        failures.push(`第${attempt + 1}次: ${res.fail}`);
        continue;
      }
      return succeed(res, strict, false);
    } catch (err) {
      const msg = sanitizeError(err, cfg.apiKey ?? '');
      // 上游 5xx：很可能是思考参数(reasoning_effort)不被该模型/网关支持
      //（部分网关对未知参数返回 500 而非 400）→ 降级重试一次（不传思考参数）。
      // callLLM 抛错时已在 err.status 上携带上游 HTTP 状态；超时 / 非 JSON /
      // 缺 content 等非 HTTP 错误没有 status，置为 0，不满足 5xx 条件，
      // 因此不会触发降级重试（重试也会以同样方式失败，纯属浪费一次往返）。
      const status = Number(err?.status);
      const upstreamStatus = Number.isFinite(status) ? status : 0;
      if (thinkingLevel && thinkingLevel !== 'default' && upstreamStatus >= 500 && upstreamStatus < 600) {
        try {
          const res = await tryOnce(messages, null);
          if (!res.ok) {
            failures.push(`第${attempt + 1}次: ${msg}；降级(去思考参数)后: ${res.fail}`);
            continue;
          }
          return succeed(res, strict, true);
        } catch (err2) {
          failures.push(`第${attempt + 1}次: ${msg}；降级(去思考参数)后: ${sanitizeError(err2, cfg.apiKey ?? '')}`);
          continue;
        }
      }
      failures.push(`第${attempt + 1}次: ${msg}`);
    }
  }

  // 两次都失败 → 计数 + 兜底
  const res = registerFailure(state, seat);
  const note = `LLM 失败(${failures.join('；')})；连续失败 ${res.count} 次${
    inAutoPilot
      ? '，仍在托管(auto-pilot)'
      : res.autoPilot
        ? '，已转入托管(auto-pilot)'
        : ''
  }`;
  const decision = fallbackMove(state, seat, model, note);
  // 结构化失败数（供对局质量统计；reason 文本已包含详情）
  decision.log.failures = failures.length;
  return decision;
}

export default {
  decideMove,
  fallbackMove,
  matchLegalMove,
  sanityCheck,
  extractJson,
  toCoordKey,
  resolveModelConfig,
  distanceToTargetHole,
};
