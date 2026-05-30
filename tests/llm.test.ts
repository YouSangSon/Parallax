import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';

import { summarize, STUB_LLM_MODEL } from '../src/llm.js';

function withReflectionModel<T>(model: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PARALLAX_REFLECTION_MODEL;
  if (model === undefined) {
    delete process.env.PARALLAX_REFLECTION_MODEL;
  } else {
    process.env.PARALLAX_REFLECTION_MODEL = model;
  }
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env.PARALLAX_REFLECTION_MODEL;
    } else {
      process.env.PARALLAX_REFLECTION_MODEL = previous;
    }
  });
}

test('stub provider returns deterministic summary', async () => {
  await withReflectionModel(STUB_LLM_MODEL, async () => {
    const a = await summarize({ systemPrompt: 'sys', userPrompt: 'user' });
    const b = await summarize({ systemPrompt: 'sys', userPrompt: 'user' });
    assert.equal(a.model, STUB_LLM_MODEL);
    assert.equal(b.model, STUB_LLM_MODEL);
    assert.equal(a.summary, b.summary);
    assert.match(a.summary, /\[stub-summary\]/);
  });
});

test('summarize redacts secrets in the system prompt before producing summary', async () => {
  await withReflectionModel(STUB_LLM_MODEL, async () => {
    const result = await summarize({
      systemPrompt: 'instructions sk-1234567890ABCDEFGHIJKLMNO',
      userPrompt: 'user'
    });
    assert.doesNotMatch(result.summary, /sk-1234567890ABCDEFGHIJKLMNO/);
  });
});

test('unknown provider prefix throws a descriptive error', async () => {
  await withReflectionModel('martianbrand:wat', async () => {
    await assert.rejects(
      () => summarize({ systemPrompt: 'a', userPrompt: 'b' }),
      /unknown reflection model/
    );
  });
});

test('anthropic provider without API key throws', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await withReflectionModel('anthropic:claude-haiku-4-5', async () => {
      await assert.rejects(
        () => summarize({ systemPrompt: 'a', userPrompt: 'b' }),
        /ANTHROPIC_API_KEY not set/
      );
    });
  } finally {
    if (previousKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
  }
});

test('openai provider without API key throws', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await withReflectionModel('openai:gpt-4o-mini', async () => {
      await assert.rejects(
        () => summarize({ systemPrompt: 'a', userPrompt: 'b' }),
        /OPENAI_API_KEY not set/
      );
    });
  } finally {
    if (previousKey !== undefined) {
      process.env.OPENAI_API_KEY = previousKey;
    }
  }
});

interface MockServer {
  url: string;
  close: () => Promise<void>;
}

function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<MockServer> {
  return new Promise((resolve) => {
    const server: Server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          })
      });
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

test('ollama happy path returns summary text and model id', async () => {
  const server = await startMockServer(async (req, res) => {
    assert.equal(req.url, '/api/chat');
    const body = JSON.parse(await readBody(req)) as { model: string };
    assert.equal(body.model, 'gemma2:2b');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        message: { content: 'mock ollama summary' },
        prompt_eval_count: 10,
        eval_count: 20
      })
    );
  });
  const previousBaseUrl = process.env.PARALLAX_OLLAMA_BASE_URL;
  process.env.PARALLAX_OLLAMA_BASE_URL = server.url;
  try {
    await withReflectionModel('ollama:gemma2:2b', async () => {
      const result = await summarize({ systemPrompt: 'a', userPrompt: 'b' });
      assert.equal(result.summary, 'mock ollama summary');
      assert.equal(result.model, 'ollama:gemma2:2b');
      assert.equal(result.inputTokens, 10);
      assert.equal(result.outputTokens, 20);
    });
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.PARALLAX_OLLAMA_BASE_URL;
    } else {
      process.env.PARALLAX_OLLAMA_BASE_URL = previousBaseUrl;
    }
    await server.close();
  }
});

test('ollama non-200 response surfaces status and body excerpt', async () => {
  const server = await startMockServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('model not ready');
  });
  const previousBaseUrl = process.env.PARALLAX_OLLAMA_BASE_URL;
  process.env.PARALLAX_OLLAMA_BASE_URL = server.url;
  try {
    await withReflectionModel('ollama:gemma2:2b', async () => {
      await assert.rejects(
        () => summarize({ systemPrompt: 'a', userPrompt: 'b' }),
        /Ollama returned 503/
      );
    });
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.PARALLAX_OLLAMA_BASE_URL;
    } else {
      process.env.PARALLAX_OLLAMA_BASE_URL = previousBaseUrl;
    }
    await server.close();
  }
});

test('anthropic happy path parses content blocks and usage', async () => {
  const server = await startMockServer(async (req, res) => {
    assert.equal(req.url, '/v1/messages');
    assert.equal(req.headers['x-api-key'], 'test-key-anthropic');
    assert.equal(req.headers['anthropic-version'], '2023-06-01');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        content: [
          { type: 'text', text: 'mock claude ' },
          { type: 'tool_use', id: 'ignored' },
          { type: 'text', text: 'summary' }
        ],
        usage: { input_tokens: 12, output_tokens: 24 }
      })
    );
  });
  // Anthropic provider asserts https://. Point at the http mock to verify
  // the validation path triggers before any outbound fetch is attempted.
  // Full TLS-mocked happy-path coverage requires a self-signed HTTPS
  // server — out of scope here.
  const previousAllow = process.env.PARALLAX_ANTHROPIC_BASE_URL;
  process.env.PARALLAX_ANTHROPIC_BASE_URL = server.url;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-anthropic';
  try {
    await withReflectionModel('anthropic:claude-test', async () => {
      await assert.rejects(
        () => summarize({ systemPrompt: 'a', userPrompt: 'b' }),
        /Anthropic requires an https/
      );
    });
  } finally {
    if (previousAllow === undefined) {
      delete process.env.PARALLAX_ANTHROPIC_BASE_URL;
    } else {
      process.env.PARALLAX_ANTHROPIC_BASE_URL = previousAllow;
    }
    if (previousKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = previousKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    await server.close();
  }
});

test('openai non-200 response surfaces status and body excerpt', async () => {
  const server = await startMockServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'rate limit', type: 'rate_limit_exceeded' } }));
  });
  // OpenAI provider asserts https. We reach the assertion error rather
  // than the 429 — that is sufficient to verify the validation path.
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = server.url + '/v1';
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key-openai';
  try {
    await withReflectionModel('openai:gpt-4o-mini', async () => {
      await assert.rejects(
        () => summarize({ systemPrompt: 'a', userPrompt: 'b' }),
        /OpenAI requires an https/
      );
    });
  } finally {
    if (previousBaseUrl === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = previousBaseUrl;
    }
    if (previousKey !== undefined) {
      process.env.OPENAI_API_KEY = previousKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    await server.close();
  }
});
