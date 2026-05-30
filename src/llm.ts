import { envValue } from './branding.js';
import { redactSecrets } from './security.js';

export interface SummarizeInput {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ReflectionResult {
  model: string;
  summary: string;
  inputTokens?: number;
  outputTokens?: number;
}

export const STUB_LLM_MODEL = 'stub';
const DEFAULT_REFLECTION_MODEL = 'ollama:gemma2:2b';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutSignal(): AbortSignal {
  const overrideRaw = envValue('LLM_TIMEOUT_MS');
  const ms = overrideRaw ? Number.parseInt(overrideRaw, 10) : DEFAULT_TIMEOUT_MS;
  return AbortSignal.timeout(Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS);
}

function assertHttps(baseUrl: string, providerLabel: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${providerLabel} base URL is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `${providerLabel} requires an https:// base URL to protect the API key in transit; got ${parsed.protocol}//`
    );
  }
}

function selectedReflectionModel(): string {
  return envValue('REFLECTION_MODEL') ?? DEFAULT_REFLECTION_MODEL;
}

/**
 * Multi-provider summarizer for reflective consolidation. Provider is
 * encoded as a prefix on the env var PARALLAX_REFLECTION_MODEL:
 *   stub                  -> deterministic in-process summary
 *   ollama:<model>        -> POST http://localhost:11434/api/chat
 *   anthropic:<model>     -> POST https://api.anthropic.com/v1/messages
 *   openai:<model>        -> POST https://api.openai.com/v1/chat/completions
 *
 * Both system and user prompts are run through redactSecrets before any
 * outbound network call, mirroring the redact-then-embed gate from
 * Phase 2. Output is also redacted before return so the caller never
 * sees an echoed secret.
 */
export async function summarize(input: SummarizeInput): Promise<ReflectionResult> {
  const safeInput: SummarizeInput = {
    systemPrompt: redactSecrets(input.systemPrompt),
    userPrompt: redactSecrets(input.userPrompt),
    maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: input.temperature ?? DEFAULT_TEMPERATURE
  };

  const modelSpec = selectedReflectionModel();
  const raw = await callProvider(modelSpec, safeInput);
  const safeOutput = redactSecrets(raw.summary);
  return { ...raw, summary: safeOutput };
}

async function callProvider(
  modelSpec: string,
  input: SummarizeInput
): Promise<ReflectionResult> {
  if (modelSpec === STUB_LLM_MODEL || modelSpec.startsWith('stub:')) {
    return summarizeStub(input);
  }
  if (modelSpec.startsWith('ollama:')) {
    return summarizeOllama(modelSpec.slice('ollama:'.length), input);
  }
  if (modelSpec.startsWith('anthropic:')) {
    return summarizeAnthropic(modelSpec.slice('anthropic:'.length), input);
  }
  if (modelSpec.startsWith('openai:')) {
    return summarizeOpenAI(modelSpec.slice('openai:'.length), input);
  }
  throw new Error(
    `unknown reflection model: ${modelSpec} (expected stub, ollama:*, anthropic:*, or openai:*)`
  );
}

function summarizeStub(input: SummarizeInput): ReflectionResult {
  const summary = `[stub-summary] sys=${input.systemPrompt.length}b user=${input.userPrompt.length}b`;
  return { model: STUB_LLM_MODEL, summary };
}

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
}

async function summarizeOllama(
  modelId: string,
  input: SummarizeInput
): Promise<ReflectionResult> {
  const baseUrl = envValue('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: timeoutSignal(),
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt }
        ],
        options: { temperature: input.temperature ?? DEFAULT_TEMPERATURE },
        stream: false
      })
    });
  } catch (error: unknown) {
    throw new Error(
      `Ollama unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama returned ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as OllamaChatResponse;
  return {
    model: `ollama:${modelId}`,
    summary: data.message?.content ?? '',
    ...(data.prompt_eval_count !== undefined ? { inputTokens: data.prompt_eval_count } : {}),
    ...(data.eval_count !== undefined ? { outputTokens: data.eval_count } : {})
  };
}

interface AnthropicMessageBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicMessageBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function summarizeAnthropic(
  modelId: string,
  input: SummarizeInput
): Promise<ReflectionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set for anthropic provider');
  }
  const baseUrl = envValue('ANTHROPIC_BASE_URL') ?? 'https://api.anthropic.com';
  assertHttps(baseUrl, 'Anthropic');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: timeoutSignal(),
      body: JSON.stringify({
        model: modelId,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: input.temperature ?? DEFAULT_TEMPERATURE,
        system: input.systemPrompt,
        messages: [{ role: 'user', content: input.userPrompt }]
      })
    });
  } catch (error: unknown) {
    throw new Error(
      `Anthropic unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic returned ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as AnthropicResponse;
  const summary = (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
  return {
    model: `anthropic:${modelId}`,
    summary,
    ...(data.usage?.input_tokens !== undefined ? { inputTokens: data.usage.input_tokens } : {}),
    ...(data.usage?.output_tokens !== undefined ? { outputTokens: data.usage.output_tokens } : {})
  };
}

interface OpenAIChoice {
  message?: { content?: string };
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function summarizeOpenAI(
  modelId: string,
  input: SummarizeInput
): Promise<ReflectionResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set for openai provider');
  }
  const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  assertHttps(baseUrl, 'OpenAI');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      signal: timeoutSignal(),
      body: JSON.stringify({
        model: modelId,
        max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: input.temperature ?? DEFAULT_TEMPERATURE,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt }
        ]
      })
    });
  } catch (error: unknown) {
    throw new Error(
      `OpenAI unreachable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI returned ${response.status}: ${body.slice(0, 200)}`);
  }
  const data = (await response.json()) as OpenAIResponse;
  const summary = data.choices?.[0]?.message?.content ?? '';
  return {
    model: `openai:${modelId}`,
    summary,
    ...(data.usage?.prompt_tokens !== undefined ? { inputTokens: data.usage.prompt_tokens } : {}),
    ...(data.usage?.completion_tokens !== undefined
      ? { outputTokens: data.usage.completion_tokens }
      : {})
  };
}
