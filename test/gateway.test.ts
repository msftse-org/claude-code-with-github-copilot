import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startGateway } from '../src/gateway.ts';
import { model, tools, request, message, sse, stream } from './fixtures.ts';
import { object } from '../src/protocol.ts';
import type { ObjectValue } from '../src/protocol.ts';

test('loopback authentication, origins, methods, routes and malformed requests consume no turns', async () => {
  const gateway = await startGateway({ model, backend: { async send() { throw new Error('Unexpected inference'); } } });
  try {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${gateway.token}` };
    for (const [path, overrides, expected] of [
      ['/v1/messages', { headers: {} }, 401],
      ['/v1/messages', { headers: { ...headers, origin: 'https://example.com' } }, 403],
      ['/v1/messages', { headers: { ...headers, authorization: `Bearer ${'é'.repeat(64)}` } }, 401],
      ['/token', { headers }, 404],
      ['/v1/messages/count_tokens', { headers }, 404],
      ['/v1/messages', { headers, method: 'GET', body: undefined }, 405],
      ['/v1/messages', { headers, body: 'not-json' }, 400],
      ['/v1/messages', { headers, body: JSON.stringify(request({ model: 'gpt-5' })) }, 400],
      ['/v1/messages', { headers, body: JSON.stringify(request({ max_tokens: model.output + 1 })) }, 400],
      ['/v1/messages', { headers, body: JSON.stringify(request({ context_management: {} })) }, 400],
    ] as const) {
      const response = await fetch(`${gateway.url}${path}`, { method: 'POST', body: JSON.stringify(request()), ...overrides });
      assert.equal(response.status, expected, `${path}: ${await response.text()}`);
      assert.equal(response.headers.get('x-should-retry'), 'false');
    }
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const call = httpRequest(`${gateway.url}/v1/messages`, { method: 'POST', headers: { ...headers, host: 'example.com' } }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      call.on('error', reject);
      call.end(JSON.stringify(request()));
    });
    assert.equal(hostStatus, 403);
    assert.equal(gateway.stats.attempts, 0);
    assert.equal((await fetch(`${gateway.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${gateway.url}/api/hello`, { method: 'HEAD' })).status, 204);
    const huge = JSON.stringify(request({ system: 'x'.repeat(8 * 1024 * 1024) }));
    assert.equal((await fetch(`${gateway.url}/v1/messages`, { method: 'POST', headers, body: huge })).status, 413);
  } finally { await gateway.close(); }
});

test('reviewed output effort is validated and forwarded unchanged without enabling other output modes', async () => {
  const rejected = await startGateway({ model, backend: { async send() { throw new Error('Unexpected inference'); } } });
  try {
    for (const output of [null, [], {}, { effort: 1 }, { effort: 'adaptive' }, { effort: 'HIGH' },
      { format: { type: 'json_schema' } }, { effort: 'high', unknown: true }]) {
      const response = await fetch(`${rejected.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': rejected.token },
        body: JSON.stringify(request({ output_config: output })),
      });
      assert.equal(response.status, 400, JSON.stringify(output));
    }
    assert.equal(rejected.stats.attempts, 0);
  } finally { await rejected.close(); }
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    let received: ObjectValue | undefined;
    const gateway = await startGateway({ model, backend: { async send(body) {
      received = structuredClone(body);
      return Response.json(message());
    } } });
    try {
      const body = request({ output_config: { effort }, thinking: { type: 'disabled' } });
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': gateway.token },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      await response.json();
      assert.deepEqual(received, body);
      assert.equal(gateway.stats.completed, 1);
    } finally { await gateway.close(); }
  }
});

test('images, documents, extended thinking, and exact connector token counting pass through', async () => {
  const supported = [
    request({ thinking: { type: 'enabled', budget_tokens: 64 } }),
    request({ thinking: { type: 'adaptive' } }),
    request({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] }),
    request({ messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } }] }] }),
  ];
  for (const body of supported) {
    let received: ObjectValue | undefined;
    const gateway = await startGateway({ model, backend: { async send(value) { received = structuredClone(value); return Response.json(message()); } } });
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': gateway.token },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      await response.json();
      assert.deepEqual(received, body);
    } finally { await gateway.close(); }
  }
  let normalized: ObjectValue | undefined;
  const compatibility = await startGateway({ model, backend: { async send(value) {
    normalized = structuredClone(value);
    return Response.json(message());
  } } });
  try {
    const body = request({
      thinking: { type: 'enabled', budget_tokens: 1024, display: 'omitted' },
      output_config: { effort: 'medium' },
      context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'system', content: [{ type: 'text', text: 'Persistent context' }], output_config: { effort: 'medium' } },
        { role: 'user', content: 'Continue' },
      ],
    });
    const response = await fetch(`${compatibility.url}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': compatibility.token },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.deepEqual(normalized?.thinking, { type: 'adaptive' });
    assert.deepEqual(normalized?.context_management, body.context_management);
  } finally { await compatibility.close(); }
  let counted: ObjectValue | undefined;
  const gateway = await startGateway({ model, backend: {
    async send() { throw new Error('Unexpected inference'); },
    async countTokens(body) { counted = structuredClone(body); return Response.json({ input_tokens: 37 }); },
  } });
  try {
    const count = await fetch(`${gateway.url}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': gateway.token },
      body: JSON.stringify(request()),
    });
    assert.equal(count.status, 200);
    assert.deepEqual(await count.json(), { input_tokens: 37 });
    assert.deepEqual(counted, request());
    assert.equal(gateway.stats.completed, 0);
  } finally { await gateway.close(); }
});

test('thinking response blocks are preserved for native and streaming responses', async () => {
  const thinking = { type: 'thinking', thinking: 'Synthetic reasoning.', signature: 'synthetic-signature' };
  for (const streaming of [false, true]) {
    const gateway = await startGateway({ model, backend: { async send() {
      if (!streaming) return Response.json(message([thinking]));
      const events = [
        { type: 'message_start', message: { ...message([], 'end_turn'), stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Synthetic reasoning.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'synthetic-signature' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    } } });
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': gateway.token },
        body: JSON.stringify(request({ stream: streaming, thinking: { type: 'enabled', budget_tokens: 64 } })),
      });
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.match(body, /synthetic-signature/);
    } finally { await gateway.close(); }
  }
});

test('text system messages preserve their role, history and tool-result matching', async () => {
  const selected = { ...model, id: 'claude-sonnet-5.5', responseIds: ['claude-sonnet-5.5'] };
  const calls: ObjectValue[] = [];
  const blocks = [{ type: 'tool_use', id: 'read-system', name: 'Read', input: { file_path: 'synthetic.txt' } }];
  const gateway = await startGateway({ model: selected, backend: { async send(body) {
    calls.push(structuredClone(body));
    return Response.json({ ...(calls.length === 1 ? message(blocks, 'tool_use') : message()), model: selected.id });
  } } });
  const post = (messages: ObjectValue[]) => fetch(`${gateway.url}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': gateway.token },
    body: JSON.stringify(request({ model: selected.id, tools, messages })),
  });
  const user = { role: 'user', content: 'Read the synthetic fixture.' };
  const note = { role: 'system', content: [{ type: 'text', text: 'Stay inside the synthetic workspace.' }] };
  try {
    for (const messages of [
      [note], [note, user], [{ role: 'assistant', content: 'Earlier reply' }, note, user],
      [user, { role: 'system', content: blocks }],
      [user, { role: 'system', content: [{ type: 'tool_result', tool_use_id: 'read-system', content: 'not a user result' }] }],
      [user, { role: 'system', content: [{ type: 'tool_removal', tool: { type: 'tool_reference', name: 'Read' } }] }],
      [user, { ...note, clear_at: 2 }],
      [user, { role: 'assistant', content: 'Prefill' }],
      [user, { role: 'developer', content: 'Unsupported role' }],
    ]) assert.equal((await post(messages)).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await post([user, note])).status, 200);
    const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-system', content: 'synthetic file' }] };
    const next = [user, note, { role: 'assistant', content: blocks }, result, { role: 'system', content: 'Report the result briefly.' }];
    assert.equal((await post(next)).status, 200);
    assert.deepEqual(calls[1]?.messages, next);
    assert.equal(gateway.stats.completed, 2);
    assert.equal((await post([user, { ...note, content: 'Changed earlier instructions' }, ...next.slice(2),
      { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Continue' }])).status, 409);
    assert.equal(calls.length, 2);
  } finally { await gateway.close(); }
});

test('native streaming preserves text, tool batches, negative results and historical transcripts', async () => {
  const calls: ObjectValue[] = [];
  const blocks = [
    { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'one.txt' } },
    { type: 'tool_use', id: 'read-2', name: 'Read', input: { file_path: 'two.txt' } },
  ];
  const gateway = await startGateway({ model, backend: { async send(body, headers) {
    assert.equal(headers.get('anthropic-beta'), 'claude-code-20250219');
    calls.push(structuredClone(body));
    return calls.length === 1 ? stream(blocks, 'tool_use') : stream();
  } } });
  const post = (body: ObjectValue) => fetch(`${gateway.url}/v1/messages?beta=true`, {
    method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json', 'anthropic-beta': 'claude-code-20250219' },
    body: JSON.stringify(body),
  });
  try {
    const a = request({ tools, stream: true });
    const response = await post(a);
    assert.equal(await response.text(), sse(blocks, 'tool_use'));
    const first = Array.isArray(a.messages) ? a.messages : [];
    const b = { ...a, messages: [...first, { role: 'assistant', content: blocks }, { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'read-1', content: 'content one' },
      { type: 'tool_result', tool_use_id: 'read-2', is_error: true, content: 'Permission denied' },
    ] }] };
    assert.equal((await post({ ...b, messages: [...first, { role: 'user', content: [] }] })).status, 409);
    assert.equal(await (await post(b)).text(), sse());
    assert.deepEqual(calls[1], b);
    assert.equal((await post(b)).status, 409);
    const c = { ...a, messages: [...b.messages, { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }, { role: 'user', content: 'Again' }] };
    assert.equal(await (await post(c)).text(), sse());
    assert.equal(calls.length, 3);
    assert.equal(gateway.stats.usage.input_tokens, 21);
    assert.equal(gateway.stats.usage.output_tokens, 9);
  } finally { await gateway.close(); }
});

test('nonstreamed model response and bounded admission', async () => {
  const gateway = await startGateway({ model, maxTurns: 1, backend: { async send() { return Response.json(message()); } } });
  try {
    const init = { method: 'POST', headers: { 'x-api-key': gateway.token, 'content-type': 'application/json' }, body: JSON.stringify(request()) };
    const first = await fetch(`${gateway.url}/v1/messages`, init);
    assert.deepEqual(await first.json(), message());
    init.body = JSON.stringify(request({ messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Next' }] }));
    assert.equal((await fetch(`${gateway.url}/v1/messages`, init)).status, 429);
    assert.equal(gateway.stats.attempts, 1);
  } finally { await gateway.close(); }
});

test('stream parser accepts arbitrary UTF-8 and CRLF chunk boundaries', async () => {
  const content = [{ type: 'text', text: 'héllo 🌍' }];
  const bytes = new TextEncoder().encode(sse(content).replaceAll('\n', '\r\n'));
  const gateway = await startGateway({ model, backend: { async send() {
    return new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } } });
  try {
    const response = await fetch(`${gateway.url}/v1/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request({ stream: true })),
    });
    assert.equal(await response.text(), sse(content));
    assert.equal(gateway.stats.completed, 1);
  } finally { await gateway.close(); }
});

test('a transport sentinel is accepted only after a complete native message', async () => {
  const complete = sse([{ type: 'text', text: '[DONE]' }]);
  const terminal = 'data: [DONE]\n\n';
  const noStop = complete.slice(0, complete.indexOf('event: message_stop'));
  for (const [upstream, valid] of [
    [complete + terminal, true],
    [complete, true],
    [terminal, false],
    [noStop + terminal, false],
    [noStop, false],
    [complete + terminal + terminal, false],
    [complete + terminal + 'event: ping\ndata: {"type":"ping"}\n\n', false],
    [complete + 'event: unknown\ndata: [DONE]\n\n', false],
    [complete + 'data: not-json\n\n', false],
  ] as const) {
    const gateway = await startGateway({ model, backend: { async send() {
      const bytes = new TextEncoder().encode(upstream.replaceAll('\n', '\r\n'));
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } } });
    try {
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': gateway.token },
        body: JSON.stringify(request({ stream: true })),
      });
      const result = await response.text();
      if (valid) assert.equal(result, complete);
      else assert.match(result, /event: error/);
      assert.equal(gateway.stats.completed, valid ? 1 : 0);
      assert.equal(gateway.stats.failed, valid ? 0 : 1);
      assert.equal(gateway.stats.attempts, 1);
    } finally { await gateway.close(); }
  }
});

test('upstream errors, partial streams and wrong models never become successful completions or retries', async () => {
  for (const scenario of ['quota', 'partial', 'wrong-model', 'undeclared-tool'] as const) {
    const gateway = await startGateway({ model, backend: { async send() {
      if (scenario === 'quota') return new Response('sensitive upstream body', { status: 429, headers: { 'retry-after': '30' } });
      if (scenario === 'wrong-model') return Response.json({ ...message(), model: 'gpt-5' });
      if (scenario === 'undeclared-tool') return stream([{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'never execute' } }], 'tool_use');
      return new Response(sse().split('event: message_delta')[0], { headers: { 'content-type': 'text/event-stream' } });
    } } });
    try {
      const init = { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request({ stream: scenario !== 'wrong-model' })) };
      const response = await fetch(`${gateway.url}/v1/messages`, init);
      const result = await response.text();
      assert.doesNotMatch(result, /sensitive upstream body/);
      if (scenario === 'quota') { assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '30'); }
      else assert.match(result, /MODEL_MISMATCH|PROTOCOL_ERROR/);
      assert.doesNotMatch(result, /event: message_stop/);
      assert.equal((await fetch(`${gateway.url}/v1/messages`, init)).status, 409);
      assert.equal(gateway.stats.completed, 0);
      assert.equal(gateway.stats.attempts, 1);
    } finally { await gateway.close(); }
  }
});

test('client cancellation and inactivity abort upstream work and retire the branch', async () => {
  for (const mode of ['cancel', 'timeout']) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let aborted = false;
    const gateway = await startGateway({ model, inactivityMs: mode === 'timeout' ? 30 : 10000, backend: { async send(_body, _headers, signal) {
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true }));
    } } });
    try {
      const controller = new AbortController();
      const work = fetch(`${gateway.url}/v1/messages`, {
        method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request()),
      });
      await ready;
      if (mode === 'cancel') { controller.abort(); await assert.rejects(work); }
      else assert.equal((await work).status, 504);
      for (let i = 0; i < 50 && !aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(aborted, true);
    } finally { await gateway.close(); }
  }
});

test('independent agent branches are isolated while stale tool results are rejected before inference', async () => {
  const calls: ObjectValue[] = [];
  const gateway = await startGateway({ model, backend: { async send(body) { calls.push(structuredClone(body)); return Response.json(message()); } } });
  try {
    for (let i = 0; i < 12; i++) {
      const unauthorized = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': 'invalid', 'content-type': 'application/json', 'x-claude-code-agent-id': `unauthorized-${i}` },
        body: JSON.stringify(request({ messages: [{ role: 'user', content: 'Rejected branch' }] })),
      });
      assert.equal(unauthorized.status, 401);
    }
    const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
    const agent = await fetch(`${gateway.url}/v1/messages`, {
      method: 'POST',
      headers: { ...headers, 'x-claude-code-agent-id': 'agent-1' },
      body: JSON.stringify(request({ messages: [{ role: 'user', content: 'Agent branch' }] })),
    });
    assert.equal(agent.status, 200);
    const main = await fetch(`${gateway.url}/v1/messages`, {
      method: 'POST', headers, body: JSON.stringify(request({ messages: [{ role: 'user', content: 'Main branch' }] })),
    });
    assert.equal(main.status, 200);
    assert.equal(calls.length, 2);
    const body = request({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'stale', content: 'no' }] }] });
    const response = await fetch(`${gateway.url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 409);
    assert.equal(object(await response.json()).type, 'error');
    assert.equal(gateway.stats.completed, 2);
  } finally { await gateway.close(); }
});

test('30 owned listener cycles close cleanly', async () => {
  for (let i = 0; i < 30; i++) {
    const gateway = await startGateway({ model, backend: { async send() { return Response.json(message()); } } });
    assert.equal((await fetch(`${gateway.url}/healthz`)).status, 200);
    await gateway.close();
    await assert.rejects(fetch(`${gateway.url}/healthz`));
  }
});

test('ten native conversation turns preserve the complete transcript without duplicate submissions', async () => {
  const calls: ObjectValue[] = [];
  const gateway = await startGateway({ model, backend: { async send(body) {
    calls.push(structuredClone(body));
    return Response.json(message());
  } } });
  try {
    const messages: ObjectValue[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'user', content: `Turn ${i}` });
      const response = await fetch(`${gateway.url}/v1/messages`, {
        method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request({ messages })),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      assert.deepEqual(calls[i]?.messages, messages);
      messages.push({ role: 'assistant', content: 'Hello' });
    }
    assert.equal(gateway.stats.completed, 10);
  } finally { await gateway.close(); }
});
