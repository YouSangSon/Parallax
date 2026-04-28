import type { AnalyzeOptions, JsonRpcRequest, JsonRpcResponse } from './types.js';
import { analyzeDiff } from './analyzer.js';

type McpContext = {
  repoRoot: string;
};

export async function handleMcpRequest(request: JsonRpcRequest, context: McpContext): Promise<JsonRpcResponse> {
  const id = request.id ?? null;
  try {
    if (request.method === 'tools/list') {
      return ok(id, {
        tools: [
          {
            name: 'impact_trace_analyze_diff',
            description: 'Analyze changed files against the latest completed Impact Trace index.',
            inputSchema: {
              type: 'object',
              properties: {
                changedFiles: {
                  type: 'array',
                  items: { type: 'string' },
                  minItems: 1
                }
              },
              required: ['changedFiles'],
              additionalProperties: false
            }
          }
        ]
      });
    }

    if (request.method === 'tools/call') {
      const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
      if (!params || params.name !== 'impact_trace_analyze_diff') {
        return fail(id, -32601, 'unknown tool');
      }
      const args = params.arguments as Partial<AnalyzeOptions> | undefined;
      if (!args || !Array.isArray(args.changedFiles) || args.changedFiles.some((value) => typeof value !== 'string')) {
        return fail(id, -32602, 'invalid changedFiles argument');
      }
      const report = await analyzeDiff({ repoRoot: context.repoRoot, changedFiles: args.changedFiles });
      return ok(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(report)
          }
        ]
      });
    }

    return fail(id, -32601, `unknown method: ${request.method}`);
  } catch (error) {
    return fail(id, -32602, error instanceof Error ? error.message : String(error));
  }
}

function ok(id: JsonRpcResponse['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: JsonRpcResponse['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

