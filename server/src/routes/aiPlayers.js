/**
 * AI 玩家路由 `/api/ai-players`（P0-2）。
 * 每个 AI 玩家绑定一个模型配置 + 一个具体模型名。
 */
import express from 'express';

import { PROMPT_STYLE_MAX, ROOM_STATUS_FINISHED, THINKING_LEVELS } from '../constants.js';
import { DEFAULT_ELO } from '../services/elo.js';
import { asyncHandler, badRequest, conflict, notFound, requireString, sendOk } from '../http.js';
import store from '../store.js';

const router = express.Router();

/**
 * 校验自定义策略模板（可选字符串；空白视为未设置）。
 * @param {any} value
 * @returns {string|null}
 */
function parsePromptStyle(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('promptStyle 必须是字符串');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > PROMPT_STYLE_MAX) {
    throw badRequest(`promptStyle 最长 ${PROMPT_STYLE_MAX} 字符`);
  }
  return trimmed;
}

/**
 * 补充展示用的模型配置名（不含任何密钥字段）。
 * @param {object} player
 * @param {object[]} configs
 * @returns {object}
 */
function decorate(player, configs) {
  const cfg = configs.find((c) => c.id === player.modelConfigId) ?? null;
  return {
    id: player.id,
    name: player.name,
    modelConfigId: player.modelConfigId,
    modelConfigName: cfg?.name ?? null,
    model: player.model,
    thinkingLevel: player.thinkingLevel ?? 'default',
    promptStyle: player.promptStyle ?? null,
    elo: Number.isFinite(player.elo) ? player.elo : DEFAULT_ELO,
    createdAt: player.createdAt ?? null,
    updatedAt: player.updatedAt ?? null,
  };
}

/**
 * 校验思考强度取值，非法则抛 400。
 * @param {any} value
 * @returns {string} 合法值（缺省 'default'）
 */
function parseThinkingLevel(value) {
  if (value === undefined || value === null || value === '') return 'default';
  if (THINKING_LEVELS.includes(value)) return value;
  throw badRequest(`thinkingLevel 必须是 ${THINKING_LEVELS.join(' | ')} 之一`);
}

/**
 * 取 AI 玩家，不存在则 404。
 * @param {string} id
 * @returns {Promise<object>}
 */
async function mustGetPlayer(id) {
  const player = await store.findById('aiPlayers', id);
  if (!player) throw notFound(`AI 玩家不存在: ${id}`);
  return player;
}

/**
 * 校验模型配置存在。
 * @param {string} modelConfigId
 * @returns {Promise<object>}
 */
async function mustGetConfig(modelConfigId) {
  const cfg = await store.findById('modelConfigs', modelConfigId);
  if (!cfg) throw notFound(`模型配置不存在: ${modelConfigId}`);
  return cfg;
}

/** GET /api/ai-players — 列表。 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const [players, configs] = await Promise.all([
      store.loadCollection('aiPlayers'),
      store.loadCollection('modelConfigs'),
    ]);
    sendOk(res, players.map((p) => decorate(p, configs)));
  }),
);

/** POST /api/ai-players — 新增。 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body?.name, 'name');
    const modelConfigId = requireString(req.body?.modelConfigId, 'modelConfigId');
    const model = requireString(req.body?.model, 'model');
    const thinkingLevel = parseThinkingLevel(req.body?.thinkingLevel);
    const promptStyle = parsePromptStyle(req.body?.promptStyle);
    await mustGetConfig(modelConfigId);
    const now = store.nowIso();
    const player = {
      id: store.newId(),
      name,
      modelConfigId,
      model,
      thinkingLevel,
      promptStyle,
      elo: DEFAULT_ELO,
      createdAt: now,
      updatedAt: now,
    };
    await store.insertItem('aiPlayers', player);
    const configs = await store.loadCollection('modelConfigs');
    sendOk(res, decorate(player, configs));
  }),
);

/** GET /api/ai-players/:id — 详情。 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const player = await mustGetPlayer(req.params.id);
    const configs = await store.loadCollection('modelConfigs');
    sendOk(res, decorate(player, configs));
  }),
);

/** PUT /api/ai-players/:id — 编辑（改名 / 换绑配置或模型）。 */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    await mustGetPlayer(req.params.id);
    /** @type {Record<string, any>} */
    const patch = { updatedAt: store.nowIso() };
    if (req.body?.name !== undefined) patch.name = requireString(req.body.name, 'name');
    if (req.body?.modelConfigId !== undefined) {
      patch.modelConfigId = requireString(req.body.modelConfigId, 'modelConfigId');
      await mustGetConfig(patch.modelConfigId);
    }
    if (req.body?.model !== undefined) patch.model = requireString(req.body.model, 'model');
    if (req.body?.thinkingLevel !== undefined) patch.thinkingLevel = parseThinkingLevel(req.body.thinkingLevel);
    if (req.body?.promptStyle !== undefined) patch.promptStyle = parsePromptStyle(req.body.promptStyle);
    const updated = await store.updateItem('aiPlayers', req.params.id, patch);
    if (!updated) throw notFound(`AI 玩家不存在: ${req.params.id}`);
    const configs = await store.loadCollection('modelConfigs');
    sendOk(res, decorate(updated, configs));
  }),
);

/** DELETE /api/ai-players/:id — 删除（被未结束房间座位占用返回 409）。 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await mustGetPlayer(req.params.id);
    const rooms = await store.loadCollection('rooms');
    const occupying = rooms.filter(
      (room) =>
        room.status !== ROOM_STATUS_FINISHED &&
        Array.isArray(room.seats) &&
        room.seats.some((seat) => seat.aiPlayerId === req.params.id),
    );
    if (occupying.length > 0) {
      throw conflict(
        `该 AI 玩家正被 ${occupying.length} 个房间占用（房间 ${occupying
          .map((r) => r.id.slice(0, 8))
          .join('、')}），请先解除座位指派`,
      );
    }
    await store.removeItem('aiPlayers', req.params.id);
    sendOk(res, null);
  }),
);

export default router;
