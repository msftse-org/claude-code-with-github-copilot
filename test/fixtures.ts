import type { Model, ObjectValue } from '../src/protocol.ts';

export const model: Model = {
  id: 'claude-sonnet-4.5', name: 'Synthetic Claude fixture', context: 200000, output: 16384,
  responseIds: ['claude-sonnet-4.5', 'claude-sonnet-4-5-20250929'],
};
export const tools = [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }];

export function request(extra: ObjectValue = {}): ObjectValue {
  return { model: model.id, max_tokens: 128, messages: [{ role: 'user', content: 'Hello' }], ...extra };
}

export function message(content: ObjectValue[] = [{ type: 'text', text: 'Hello' }], stop = 'end_turn'): ObjectValue {
  return {
    id: 'msg_fixture', type: 'message', role: 'assistant', model: model.id, content,
    stop_reason: stop, stop_sequence: null, usage: { input_tokens: 7, output_tokens: 3 },
  };
}

export function sse(content: ObjectValue[] = [{ type: 'text', text: 'Hello' }], stop = 'end_turn', id = 'msg_fixture', responseModel = model.id): string {
  const events: ObjectValue[] = [{
    type: 'message_start', message: { ...message([], stop), model: responseModel, id, stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } },
  }];
  content.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text'
      ? { type: 'text', text: '' } : { ...block, input: {} } });
    events.push({ type: 'content_block_delta', index, delta: block.type === 'text'
      ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' });
  return events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join('');
}

export function stream(content?: ObjectValue[], stop?: string, id?: string, responseModel?: string): Response {
  return new Response(sse(content, stop, id, responseModel), { headers: { 'content-type': 'text/event-stream' } });
}
