/**
 * 模型配置路由 `/api/model-configs`（P0-1、P0-5）。
 * 响应中**绝不包含 apiKey**：统一走 store.toPublicModelConfig()。
 */
import express from 'express';

import { ERROR_CODES } from '../constants.js';
import {
  asyncHandler,
  conflict,
  notFound,
  requireString,
  sendOk,
  badRequest,
} from '../http.js';
import store from '../store.js';
import { listModels, sanitizeError, testConnection } from '../services/modelProvider.js';

const router = express.Router();

/**
 * 按 id 取内部配置对象（含 apiKey，仅服务端使用）。
 * @param {string} id
 * @returns {Promise<object>}
 */
async function mustGetConfig(id) {
  const cfg = await store.findById('modelConfigs', id);
  if (!cfg) throw notFound(`模型配置不存在: ${id}`);
  return cfg;
}

/**
 * 校验 baseUrl 形态（必须是 http/https 绝对地址）。
 * @param {string} value
 * @returns {string}
 */
function normalizeBaseUrl(value) {
  const raw = requireString(value, 'baseUrl');
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest('baseUrl 必须是合法的 URL，例如 https://api.openai.com/v1');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('baseUrl 仅支持 http/https');
  }
  return raw.replace(/\/+$/, '');
}

/** GET /api/model-configs — 列表（公开字段）。 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await store.loadCollection('modelConfigs');
    sendOk(res, items.map(store.toPublicModelConfig));
  }),
);

/** POST /api/model-configs — 新增。 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = requireString(req.body?.name, 'name');
    const baseUrl = normalizeBaseUrl(req.body?.baseUrl);
    const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
    const now = store.nowIso();
    const cfg = {
      id: store.newId(),
      name,
      baseUrl,
      apiKey,
      models: [],
      createdAt: now,
      updatedAt: now,
    };
    await store.insertItem('modelConfigs', cfg);
    sendOk(res, store.toPublicModelConfig(cfg));
  }),
);

/** GET /api/model-configs/:id — 详情（公开字段）。 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const cfg = await mustGetConfig(req.params.id);
    sendOk(res, store.toPublicModelConfig(cfg));
  }),
);

/** PUT /api/model-configs/:id — 编辑（apiKey 传空字符串表示保留原值）。 */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const cfg = await mustGetConfig(req.params.id);
    /** @type {Record<string, any>} */
    const patch = { updatedAt: store.nowIso() };
    if (req.body?.name !== undefined) patch.name = requireString(req.body.name, 'name');
    if (req.body?.baseUrl !== undefined) {
      patch.baseUrl = normalizeBaseUrl(req.body.baseUrl);
      if (patch.baseUrl !== cfg.baseUrl) patch.models = []; // 换了地址，模型缓存失效
    }
    if (typeof req.body?.apiKey === 'string' && req.body.apiKey.trim() !== '') {
      patch.apiKey = req.body.apiKey.trim();
    }
    const updated = await store.updateItem('modelConfigs', req.params.id, patch);
    if (!updated) throw notFound(`模型配置不存在: ${req.params.id}`);
    sendOk(res, store.toPublicModelConfig(updated));
  }),
);

/** DELETE /api/model-configs/:id — 删除（被 AI 玩家占用返回 409）。 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    await mustGetConfig(req.params.id);
    const aiPlayers = await store.loadCollection('aiPlayers');
    const occupied = aiPlayers.filter((p) => p.modelConfigId === req.params.id);
    if (occupied.length > 0) {
      throw conflict(
        `该模型配置被 ${occupied.length} 个 AI 玩家占用（${occupied
          .map((p) => p.name)
          .join('、')}），请先解绑或删除这些 AI 玩家`,
      );
    }
    await store.removeItem('modelConfigs', req.params.id);
    sendOk(res, null);
  }),
);

/** GET /api/model-configs/:id/models — 代理拉取模型列表（并缓存 modelCount）。 */
router.get(
  '/:id/models',
  asyncHandler(async (req, res) => {
    const cfg = await mustGetConfig(req.params.id);
    let models = [];
    try {
      const result = await listModels(cfg);
      models = Array.isArray(result?.models) ? result.models : [];
    } catch (err) {
      return res.status(ERROR_CODES.LLM_UNAVAILABLE).json({
        code: ERROR_CODES.LLM_UNAVAILABLE,
        data: null,
        message: `拉取模型列表失败: ${sanitizeError(err, cfg.apiKey ?? '')}`,
      });
    }

    // 远端拉取成功：尝试在本地更新缓存与 modelCount（即使文件被锁也不阻断正常响应）
    try {
      await store.updateItem('modelConfigs', cfg.id, { models, updatedAt: store.nowIso() });
    } catch (storeErr) {
      console.warn(`[modelConfigs] 缓存模型列表到 store 失败 (非阻塞):`, storeErr?.message);
    }

    sendOk(res, models);
  }),
);

/** POST /api/model-configs/:id/test — 连通性测试（成功/失败 + 耗时）。 */
router.post(
  '/:id/test',
  asyncHandler(async (req, res) => {
    const cfg = await mustGetConfig(req.params.id);
    const result = await testConnection(cfg);
    if (result.ok) {
      try {
        await store.updateItem('modelConfigs', cfg.id, { lastTestedAt: store.nowIso() });
      } catch (storeErr) {
        console.warn(`[modelConfigs] 记录 lastTestedAt 失败 (非阻塞):`, storeErr?.message);
      }
    }
    sendOk(res, result);
  }),
);

export default router;
