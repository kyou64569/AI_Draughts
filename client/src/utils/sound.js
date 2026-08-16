/**
 * 音效系统（2026-08-17 · UI Designer）。
 *
 * 采用 Web Audio API **程序化合成**，不依赖任何外部音频文件：
 *  - 不存在"音频文件缺失"导致报错的可能（最健壮的方案）；
 *  - 三种音色用不同的合成参数区分：按钮点击 / 单步移动 / 连跳（每次跳跃一个上行音，连奏）；
 *  - 惰性创建 AudioContext（必须由用户手势触发，否则自动挂起）；
 *  - 全局开关持久化到 localStorage，关闭时不创建/播放任何音频。
 */

const STORAGE_KEY = 'ai-draughts-sound';

/** 连跳音阶（半音程，随跳数上行：哒-哒-哒↑）。 */
const JUMP_SCALE_SEMIS = [0, 4, 7, 12, 16, 19, 24];

class SoundManager {
  constructor() {
    this.enabled = false;
    this.ctx = null;
    try {
      this.enabled = localStorage.getItem(STORAGE_KEY) !== 'off';
    } catch {
      this.enabled = true;
    }
  }

  /** 是否开启。 */
  isEnabled() {
    return this.enabled;
  }

  /** 设置开关（持久化）。 */
  setEnabled(on) {
    this.enabled = Boolean(on);
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      /* 忽略存储异常 */
    }
  }

  /** 切换开关，返回新状态。 */
  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /**
   * 惰性获取 AudioContext（首次播放由用户手势触发，浏览器允许创建）。
   * @returns {AudioContext|null}
   */
  _ctx() {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null; // 环境不支持 → 静默降级
      try {
        this.ctx = new AC();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /**
   * 合成单个音（频率包络 + 指数衰减，杜绝爆音）。
   * @param {{freq:number, endFreq?:number, dur?:number, type?:OscillatorType, gain?:number, when?:number, attack?:number}} opts
   */
  _tone({ freq, endFreq = freq, dur = 0.12, type = 'sine', gain = 0.18, when = 0, attack = 0.004 }) {
    const ctx = this._ctx();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** 按钮点击：短促高频 tick（方波 + 快速衰减）。 */
  click() {
    if (!this.enabled) return;
    try {
      this._tone({ freq: 2200, endFreq: 900, dur: 0.07, type: 'square', gain: 0.055 });
    } catch {
      /* 播放失败静默忽略，绝不向上抛 */
    }
  }

  /** 单步移动：轻快"嗒"（三角波，木鱼感）。 */
  move() {
    if (!this.enabled) return;
    try {
      this._tone({ freq: 720, endFreq: 500, dur: 0.1, type: 'triangle', gain: 0.16 });
    } catch {
      /* 同上 */
    }
  }

  /**
   * 连跳：每次跳跃一个上行音，按 AudioContext 时间轴连奏。
   * @param {number} steps 跳跃次数（path 长度 - 1）
   */
  multiJump(steps = 1) {
    if (!this.enabled) return;
    try {
      const base = 440;
      const n = Math.max(1, Math.min(Math.floor(steps), 12));
      for (let i = 0; i < n; i += 1) {
        const semis = JUMP_SCALE_SEMIS[Math.min(i, JUMP_SCALE_SEMIS.length - 1)];
        const f = base * Math.pow(2, semis / 12);
        this._tone({ freq: f, endFreq: f * 0.92, dur: 0.09, type: 'triangle', gain: 0.17, when: i * 0.085 });
      }
    } catch {
      /* 同上 */
    }
  }
}

/** 全局单例。 */
export const sound = new SoundManager();

export default sound;
