// Mock model servers for the round 7 tests: an OpenAI-compatible streaming endpoint (the Portkey path) and
// Ollama's native /api/chat + /api/show (the Ollama path, incl. the non-streaming summary request).
const http = require('node:http');

function startMock() {
  const state = { requests: [], replies: [], ollamaPromptTokens: 50, summary: 'SUMMARY PLACEHOLDER', summaryFails: false, delayMs: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      state.requests.push({ url: req.url, payload });
      const json = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/show') return json(200, { capabilities: ['completion', 'tools'] });
      // The local models, for the model menu: whatever `ollamaModels` lists (none unless a test sets it)
      if (req.url === '/api/tags' && state.ollamaModels) return json(200, { models: state.ollamaModels.map((name) => ({ name, model: name })) });
      if (req.url === '/api/chat') {
        if (!payload.stream) {
          setTimeout(() => {
            if (state.summaryFails) return json(500, { error: 'summary failed (test)' });
            json(200, { model: payload.model, message: { role: 'assistant', content: state.summary }, done: true, prompt_eval_count: 400, eval_count: 120 });
          }, state.summaryDelayMs ?? 0);
          return;
        }
        // As on the OpenAI-compatible path: a reply with `when(payload)` only answers requests it matches, and
        // `delayMs` holds it back (a run that stays in progress). Replies without either answer in order, at once.
        const at = state.replies.findIndex((r) => typeof r.when !== 'function' || r.when(payload));
        const reply = at >= 0 ? state.replies.splice(at, 1)[0] : { content: 'Done.' };
        const message = { role: 'assistant', content: reply.content ?? '' };
        if (reply.toolCalls) message.tool_calls = reply.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
        const answer = () => {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.end(JSON.stringify({ model: payload.model, message, done: true, done_reason: reply.toolCalls ? 'tool_calls' : 'stop', prompt_eval_count: reply.promptTokens ?? state.ollamaPromptTokens, eval_count: 20 }) + '\n');
        };
        if (reply.delayMs) setTimeout(answer, reply.delayMs);
        else answer();
        return;
      }
      if (req.url !== '/v1/chat/completions') return json(404, {});
      if (!payload.stream) return json(200, { id: 't', object: 'chat.completion', created: 0, model: payload.model, choices: [{ index: 0, message: { role: 'assistant', content: state.summaryFails ? '' : state.summary }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 120 } });
      // A reply with `when(payload)` only answers requests it matches (concurrent sessions share one mock); the first
      // matching reply is used. `delayMs` delays that reply; `chunks` streams the content in pieces `chunkDelayMs` apart.
      const at = state.replies.findIndex((r) => typeof r.when !== 'function' || r.when(payload));
      const reply = at >= 0 ? state.replies.splice(at, 1)[0] : { content: 'Done.' };
      setTimeout(async () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (obj) => res.write(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: payload.model, ...obj })}\n\n`);
        if (reply.chunks) {
          for (const piece of reply.chunks) {
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: piece } }] });
            await new Promise((r) => setTimeout(r, reply.chunkDelayMs ?? 50));
          }
        } else if (reply.content) send({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.content } }] });
        if (reply.toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: reply.toolCalls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls ? 'tool_calls' : 'stop' }] });
        send({ choices: [], usage: { prompt_tokens: reply.promptTokens ?? 300, completion_tokens: 30 } });
        res.write('data: [DONE]\n\n');
        res.end();
      }, reply.delayMs ?? state.delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({ ...state, port: server.address().port, state, close: () => server.close() }));
  });
}

module.exports = { startMock };
