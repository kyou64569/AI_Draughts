/**
 * 多协议适配层单测（建议 4.2）：
 * 请求体构建、响应解析、SSE 流解析（openai / anthropic / gemini）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAnthropicBody,
  buildGeminiBody,
  buildOpenAIBody,
  createStreamParser,
  normalizeProvider,
  parseAnthropicResponse,
  parseGeminiResponse,
  parseOpenAIResponse,
  splitMessages,
} from '../src/services/modelProvider.js';

const MESSAGES = [
  { role: 'system', content: '你是跳棋 AI。' },
  { role: 'user', content: '棋盘状态…请输出 JSON' },
];

test('normalizeProvider：未知/缺省回退 openai', () => {
  assert.equal(normalizeProvider(undefined), 'openai');
  assert.equal(normalizeProvider('openai'), 'openai');
  assert.equal(normalizeProvider('anthropic'), 'anthropic');
  assert.equal(normalizeProvider('gemini'), 'gemini');
  assert.equal(normalizeProvider('whatever'), 'openai');
});

test('splitMessages：system 抽离 + 角色保留', () => {
  const { systemText, chats } = splitMessages(MESSAGES);
  assert.equal(systemText, '你是跳棋 AI。');
  assert.deepEqual(chats, [{ role: 'user', content: '棋盘状态…请输出 JSON' }]);
});

test('buildOpenAIBody：参数透传与流式选项', () => {
  const plain = buildOpenAIBody('m1', MESSAGES, { maxTokens: 1024 });
  assert.equal(plain.stream, false);
  assert.equal(plain.max_tokens, 1024);
  assert.equal(plain.messages.length, 2);
  assert.ok(!('reasoning_effort' in plain));

  const thought = buildOpenAIBody('m1', MESSAGES, { thinkingLevel: 'high' });
  assert.equal(thought.reasoning_effort, 'high');

  const stream = buildOpenAIBody('m1', MESSAGES, { stream: true });
  assert.equal(stream.stream, true);
  assert.deepEqual(stream.stream_options, { include_usage: true });
});

test('buildAnthropicBody：system 参数化 + max_tokens 必填', () => {
  const body = buildAnthropicBody('claude-x', MESSAGES, {});
  assert.equal(body.system, '你是跳棋 AI。');
  assert.deepEqual(body.messages, [{ role: 'user', content: '棋盘状态…请输出 JSON' }]);
  assert.equal(body.max_tokens, 2048);
  assert.ok(!('reasoning_effort' in body));

  const withMax = buildAnthropicBody('claude-x', MESSAGES, { maxTokens: 4096 });
  assert.equal(withMax.max_tokens, 4096);
});

test('buildGeminiBody：systemInstruction + assistant→model', () => {
  const body = buildGeminiBody('gemini-x', [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
    { role: 'assistant', content: 'A' },
  ]);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'S' }] });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: 'U' }] },
    { role: 'model', parts: [{ text: 'A' }] },
  ]);
  assert.equal(body.generationConfig.maxOutputTokens, 2048);
});

test('parseOpenAIResponse：文本与 usage', () => {
  const r = parseOpenAIResponse({
    choices: [{ message: { content: '{"from":1}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
  assert.equal(r.content, '{"from":1}');
  assert.equal(r.truncated, false);
  assert.deepEqual(r.usage, { promptTokens: 100, completionTokens: 20 });

  const cut = parseOpenAIResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] });
  assert.equal(cut.truncated, true);
  assert.equal(cut.usage, null);
});

test('parseAnthropicResponse：text 块拼接 + thinking 回退 + usage', () => {
  const r = parseAnthropicResponse({
    content: [
      { type: 'thinking', thinking: '我想想…' },
      { type: 'text', text: '{"a"' },
      { type: 'text', text: ':1}' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 30, output_tokens: 12 },
  });
  assert.equal(r.content, '{"a":1}');
  assert.deepEqual(r.usage, { promptTokens: 30, completionTokens: 12 });

  const onlyThinking = parseAnthropicResponse({
    content: [{ type: 'thinking', thinking: '{"q":1,"r":0,"s":-1}' }],
    stop_reason: 'max_tokens',
  });
  assert.equal(onlyThinking.content, '{"q":1,"r":0,"s":-1}');
  assert.equal(onlyThinking.truncated, true);
});

test('parseGeminiResponse：thought 块跳过 + usageMetadata', () => {
  const r = parseGeminiResponse({
    candidates: [
      {
        content: { parts: [{ text: '思路', thought: true }, { text: '{"f"' }, { text: ':2}' }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8 },
  });
  assert.equal(r.content, '{"f":2}');
  assert.deepEqual(r.usage, { promptTokens: 50, completionTokens: 8 });
});

test('流式解析 openai：reasoning/content/usage，跨 chunk 断行安全', () => {
  const deltas = [];
  const p = createStreamParser('openai', (d) => deltas.push(d));
  p.push('data: {"choices":[{"delta":{"reasoning_content":"思考A"}}]}\n\ndata: {"ch');
  p.push('oices":[{"delta":{"content":"{\\"f\\""}}]}\n');
  p.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\ndata: [DONE]\n');
  const r = p.result();
  assert.equal(r.reasoning, '思考A');
  assert.equal(r.content, '{"f"');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.usage, { promptTokens: 9, completionTokens: 3 });
  assert.deepEqual(
    deltas.map((d) => d.kind),
    ['thinking', 'content'],
  );
});

test('流式解析 openai：thinking/reasoning 备用字段同样累积为思考片段', () => {
  // 与 parseOpenAIResponse 的回退链对齐：部分网关把思考放在 delta.thinking / delta.reasoning
  for (const field of ['thinking', 'reasoning']) {
    const deltas = [];
    const p = createStreamParser('openai', (d) => deltas.push(d));
    p.push(`data: {"choices":[{"delta":{"${field}":"想"}}]}\n`);
    p.push('data: {"choices":[{"delta":{"content":"答"}}]}\n');
    const r = p.result();
    assert.equal(r.reasoning, '想', `字段 ${field}`);
    assert.equal(r.content, '答', `字段 ${field}`);
    assert.deepEqual(
      deltas.map((d) => d.kind),
      ['thinking', 'content'],
      `字段 ${field}`,
    );
  }
});

test('流式解析 anthropic：thinking_delta/text_delta/usage 累积', () => {
  const deltas = [];
  const p = createStreamParser('anthropic', (d) => deltas.push(d));
  p.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n');
  p.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"推理"}}\n\n');
  p.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"OK"}}\n\n');
  p.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n');
  const r = p.result();
  assert.equal(r.reasoning, '推理');
  assert.equal(r.content, 'OK');
  assert.equal(r.finishReason, 'end_turn');
  assert.deepEqual(r.usage, { promptTokens: 11, completionTokens: 7 });
});

test('流式解析 gemini：thought 标记区分思考与正文', () => {
  const deltas = [];
  const p = createStreamParser('gemini', (d) => deltas.push(d));
  p.push('data: {"candidates":[{"content":{"parts":[{"text":"想","thought":true}]}}]}\n\n');
  p.push('data: {"candidates":[{"content":{"parts":[{"text":"答"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\n\n');
  const r = p.result();
  assert.equal(r.reasoning, '想');
  assert.equal(r.content, '答');
  assert.deepEqual(r.usage, { promptTokens: 5, completionTokens: 2 });
});

console.log('=== providers 单测全部通过 ===');
