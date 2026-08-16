import { useCallback, useEffect, useState } from 'react';
import { fetchModels } from '../api/client.js';

/**
 * 拉取某模型配置的模型列表（供 AI 玩家表单下拉选择）。
 * @param {string|null} configId
 */
export function useModels(configId) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!configId) {
      setModels([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const m = await fetchModels(configId);
      setModels(Array.isArray(m) ? m : []);
    } catch (e) {
      setError(e?.message || '拉取失败');
      setModels([]);
    } finally {
      setLoading(false);
    }
  }, [configId]);

  useEffect(() => {
    load();
  }, [load]);

  return { models, loading, error, reload: load };
}
