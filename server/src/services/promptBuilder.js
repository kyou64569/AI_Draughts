/**
 * Prompt 构建（P1-4）：把棋盘状态、上一手、目标营地与全部合法走法喂给 LLM，
 * 并严格约束输出为 JSON `{from:{q,r,s}, to:{q,r,s}, reason}`。
 */
import { COLOR_LABELS, PIECES_PER_COLOR, SEAT_COLORS } from '../constants.js';
import { TARGET_APEX, TARGET_CELLS, parseKey } from '../engine/board.js';
import { applyMove, countInTarget, getAllLegalMoves, isJump } from '../engine/rules.js';
import { computeFillPlan, computeMoveGain, futureMaxGain } from '../engine/fillPlan.js';

/** 候选走法清单的最大条数（防止 prompt 过长）。 */
const MAX_CANDIDATES = 160;

/** 注入到 prompt 的"本座位最近走子"条数（给 LLM 跨回合记忆，避免原地往复）。 */
const RECENT_OWN_MOVES = 3;

/**
 * 序列化棋盘上"有子"的坐标，按颜色分组。
 * @param {Record<string, string|null>} board
 * @returns {string}
 */
export function serializeBoard(board) {
  /** @type {Record<string, string[]>} */
  const grouped = { red: [], green: [], blue: [] };
  for (const k of Object.keys(board)) {
    const c = board[k];
    if (c != null && grouped[c]) grouped[c].push(k);
  }
  const lines = [];
  for (const color of SEAT_COLORS) {
    grouped[color].sort();
    lines.push(`${color}(${COLOR_LABELS[color]}): ${grouped[color].join(' | ')}`);
  }
  return lines.join('\n');
}

/**
 * 目标营地方向提示：由顶点坐标的正向大分量推出"推进方向"，
 * 让 LLM 不必在 121 格坐标里自行反推方向（避免误入别家营地）。
 * @param {'red'|'green'|'blue'} color
 * @returns {string} 如 "顶点 8,-4,-4（q 增大方向）"
 */
export function targetDirectionHint(color) {
  const apex = TARGET_APEX[color];
  const [q, r, s] = parseKey(apex);
  const axes = { q: Math.abs(q), r: Math.abs(r), s: Math.abs(s) };
  const axis = Object.entries(axes).sort((a, b) => b[1] - a[1])[0][0];
  return `${apex}（${axis} 增大方向）`;
}

/**
 * 生成"全部合法走法"候选清单（连跳只给起点→终点，并标注跳跃步数与推进收益）。
 * 收益 = 到当前落位点 nextHole 的立方距离减少量（与确定性兜底算法一致）：
 *   - 精确落在 nextHole 额外 +2；
 *   - 已就位（settled，营地深前缀）棋子的走法标注"已就位勿动"；
 *   - **铺路前瞻**：标注"后续+N"（走完后本方可获得的最大下一手收益，×0.5 计入总分），
 *     让 LLM 理解"当前收益小但为下回合铺路"的走法同样有价值；
 *   - 按总分（当前收益 + 0.5×后续）降序排列，引导 LLM 以收益为准。
 * @param {Record<string, string|null>} board
 * @param {'red'|'green'|'blue'} color
 * @returns {{text:string, count:number, moves:string[][]}}
 */
export function buildCandidateList(board, color) {
  const moves = getAllLegalMoves(board, color);
  const { settled } = computeFillPlan(board, color);
  /** @type {Map<string, {path:string[], kind:string, gain:number, future:number, total:number, isSettled:boolean}>} */
  const uniq = new Map();
  for (const path of moves) {
    const from = path[0];
    const to = path[path.length - 1];
    const id = `${from}->${to}`;
    const kind = isJump(path) ? `连跳x${path.length - 1}` : '单步';
    const existing = uniq.get(id);
    // 同终点时保留跳数更多的描述（信息量更大）
    if (!existing || path.length > existing.path.length) {
      const isSettled = settled.has(from);
      let gain = isSettled ? Number.NEGATIVE_INFINITY : 0;
      let future = 0;
      let total = Number.NEGATIVE_INFINITY;
      if (!isSettled) {
        gain = computeMoveGain(board, from, to, color);
        // 铺路前瞻：走完后本方可获得的最大下一手收益
        future = futureMaxGain(applyMove(board, path), color);
        total = gain + future * 0.5;
      }
      uniq.set(id, { path, kind, gain, future, total, isSettled });
    }
  }
  // 按综合评分降序：收益大排前，已就位（勿动）排最后
  const entries = [...uniq.entries()].sort((a, b) => b[1].total - a[1].total);
  const shown = entries.slice(0, MAX_CANDIDATES);
  const text = shown
    .map(([id, v]) => {
      if (v.isSettled) return `${id} (${v.kind}, 已就位勿动)`;
      const futureNote = v.future > 0 ? `, 后续+${v.future}` : '';
      return `${id} (${v.kind}, 推进${v.gain >= 0 ? '+' : ''}${v.gain}${futureNote})`;
    })
    .join('\n');
  const suffix =
    entries.length > shown.length ? `\n...（另有 ${entries.length - shown.length} 条未列出）` : '';
  return { text: text + suffix, count: entries.length, moves };
}

/**
 * 上一手描述。
 * @param {object} state GameState
 * @returns {string}
 */
export function describeLastMove(state) {
  const last = state.history?.[state.history.length - 1];
  if (!last) return '无（本局第一手）';
  const player = state.players[last.seat];
  return `${player?.color ?? `seat${last.seat}`} ${last.from} -> ${last.to}${
    last.path && last.path.length >= 3 ? `（连跳，路径 ${last.path.join(' -> ')}）` : '（单步）'
  }`;
}

/**
 * 描述该座位最近 N 手（供 LLM 形成跨回合记忆，避免"跳过去又跳回来"）。
 * @param {object} state GameState
 * @param {number} seat 座位号
 * @param {number} [n=RECENT_OWN_MOVES] 最多回溯手数
 * @returns {string}
 */
export function describeOwnRecentMoves(state, seat, n = RECENT_OWN_MOVES) {
  /** @type {object[]} */
  const own = [];
  for (let i = state.history.length - 1; i >= 0 && own.length < n; i -= 1) {
    if (state.history[i].seat === seat) own.unshift(state.history[i]);
  }
  if (own.length === 0) return '无（本局第一手）';
  return own
    .map((m) => {
      const pathDesc = m.path && m.path.length >= 3 ? `（连跳 ${m.path.join(' -> ')}）` : '';
      return `${m.from} -> ${m.to}${pathDesc}`;
    })
    .join('；');
}

/**
 * 对局阶段 → 策略提示（阶段化策略，P1-③）：
 *  开局：优先连跳大步推进、整体压上；中盘：均衡推进与连跳、为后续留跳板；
 *  收尾：按由深到浅顺序精确落位、单步稳步推进（此时跳板少，连跳机会天然减少）。
 * @param {number} inTarget 当前已入营子数
 * @returns {string}
 */
export function phaseStrategyHint(inTarget) {
  if (inTarget >= 8) {
    return '【收尾阶段】剩余棋子不多，按由深到浅顺序逐个精确落位；此阶段跳板少，单步稳步推进即可，不要为了连跳而绕远路。';
  }
  if (inTarget >= 3) {
    return '【中盘阶段】均衡推进与连跳；保持己方棋子之间留有跳板距离，为后续连跳创造机会，避免棋子挤成一团。';
  }
  return '【开局阶段】优先用连跳大步推进、快速打通中盘通道；不要急于把单颗棋子送进营地，先让整体向前压上。';
}

/**
 * 构建对话消息。
 * @param {object} state GameState
 * @param {number} seat 座位号
 * @param {{strict?: boolean}} [options] strict=true 时使用更严格的 system 提示（重试用）
 * @returns {{messages: Array<{role:string, content:string}>, candidateCount: number}}
 */
export function buildPrompt(state, seat, options = {}) {
  const strict = Boolean(options.strict);
  const player = state.players[seat];
  const color = player.color;
  const targetCells = TARGET_CELLS[color];
  const { text: candidateText, count: candidateCount } = buildCandidateList(state.board, color);
  const inTarget = countInTarget(state.board, color);

  const baseSystem = [
    '你是中国跳棋（六角星棋盘，立方坐标 q,r,s 且 q+r+s=0）的博弈 AI。',
    '只输出一个 JSON 对象，不要输出解释、Markdown 代码块或多余文字。',
    '格式：{"from":{"q":<int>,"r":<int>,"s":<int>},"to":{"q":<int>,"r":<int>,"s":<int>},"reason":"<不超过80字的中文理由>"}',
    'from 必须是你自己颜色的棋子；to 必须是 from 经"一步单步"或"一条完整连跳"可达的空格。',
    '连跳一旦开始必须跳到无子可跳为止，不可中途停留；单步与连跳是两种独立走法。',
    '你必须从"合法走法清单"中原样选择一条（from->to 必须在清单里）。',
    '输出体积控制：reason 尽量精简（60 字内），整体输出（JSON）务必简短，全文一般不超过约 300 字符，避免超出输出上限被截断。',
  ].join('\n');

  const strictSystem = [
    '【严格模式】上一次回复无法解析、走法非法或不满足约束，这是最后一次机会。',
    '输出必须且只能是一行 JSON，首字符是 {，尾字符是 }，不得含反引号、注释或任何前后缀文字。',
    '必须从给定"合法走法清单"中逐字复制一条 from->to 的坐标，不得自行推算或修改数字。',
    '禁止选择与"你最近的走子"完全反向的走法（原地往返）；禁止移动已就位于目标营地的棋子。',
    'reason 字段必须是短中文字符串。',
  ].join('\n');

  const user = [
    `棋盘(有子坐标, 共 ${Object.values(state.board).filter((v) => v != null).length} 子):`,
    serializeBoard(state.board),
    '',
    `你是 ${color}（${COLOR_LABELS[color]}），座位 ${seat}。`,
    `你的目标营地(需占满 ${PIECES_PER_COLOR} 格, 当前已占 ${inTarget} 格): ${targetCells.join(' | ')}`,
    `目标营地顶点(最深格)与推进方向: ${targetDirectionHint(color)}`,
    `当前应优先填充的营地格(最深空格, 营地必须由深到浅填): ${computeFillPlan(state.board, color).nextHole}`,
    `上一手: ${describeLastMove(state)}`,
    `你最近的走子(最近 ${RECENT_OWN_MOVES} 手, 供你避免原地往返): ${describeOwnRecentMoves(
      state,
      seat,
    )}`,
    '',
    `你的合法走法清单（共 ${candidateCount} 条, 格式 from->to, 括号内为跳跃类型与"推进收益"）:`,
    candidateText || '（无合法走法）',
    '',
    '策略提示：以"推进收益"数字为准选择走法（收益 = 与目标营地距离的减少量，越大越好）；',
    '连跳通常推进更大，但**不要为了跳得多而绕路**——若某条连跳的推进收益低于可选单步，应选单步；推进为负（后退）的走法不应选择，除非确无更好选择。',
    '（括号内"后续+N"表示该步走完后、下回合本方可获得的最大潜在收益：当前收益小但能为下回合铺路（搭跳板/占位）的走法同样有价值。）',
    phaseStrategyHint(inTarget),
    '【硬性约束】禁止立即走回你上一手的起点（原地往返）；已进入目标营地的棋子不得离开营地；标注"已就位勿动"的棋子不要移动。',
    '请选择最优走法并给出简短理由，只输出 JSON。',
  ].join('\n');

  return {
    messages: [
      { role: 'system', content: strict ? `${baseSystem}\n${strictSystem}` : baseSystem },
      { role: 'user', content: user },
    ],
    candidateCount,
  };
}

export default {
  buildPrompt,
  buildCandidateList,
  serializeBoard,
  describeLastMove,
  describeOwnRecentMoves,
  targetDirectionHint,
  phaseStrategyHint,
};
