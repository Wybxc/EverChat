import type { ModelCatalog } from '../catalog';
// Generated from https://models.dev/api.json on 2026-10-15.
// Public metadata only; update with pnpm update:model-catalog.
export const MODEL_CATALOG_SNAPSHOT: ModelCatalog = {
  "openai": {
    "chatgpt-image-latest": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true
    },
    "gpt-5.4": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-5.4-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-3.5-turbo": {
      "toolCalls": false,
      "reasoning": false,
      "structuredOutput": false,
      "imageInput": false,
      "contextWindow": 16385,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "gpt-5.5-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "medium",
        "high",
        "xhigh"
      ]
    },
    "text-embedding-3-small": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8191,
      "contextScope": "combined",
      "maxOutputTokens": 1536
    },
    "gpt-5.4-nano": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-realtime-2.1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 96000,
      "contextScope": "input",
      "maxOutputTokens": 32000,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-4o-2024-05-13": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "gpt-4o": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "gpt-5-mini": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gpt-5.2-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "medium",
        "high",
        "xhigh"
      ]
    },
    "o4-mini": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 100000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "o3-mini": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 100000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "text-embedding-ada-002": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8192,
      "contextScope": "combined",
      "maxOutputTokens": 1536
    },
    "gpt-4": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": false,
      "imageInput": false,
      "contextWindow": 8192,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "gpt-5.3-codex": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-4.1-nano": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1047576,
      "contextScope": "combined",
      "maxOutputTokens": 32768
    },
    "gpt-5-nano": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gpt-5.6": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "gpt-5.2-chat-latest": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": [
        "medium"
      ]
    },
    "o1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 100000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gpt-5-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 272000,
      "reasoningEfforts": [
        "high"
      ]
    },
    "gpt-5.3-codex-spark": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 100000,
      "contextScope": "input",
      "maxOutputTokens": 32000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-6.1-sol": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "text-embedding-3-large": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8191,
      "contextScope": "combined",
      "maxOutputTokens": 3072
    },
    "gpt-4o-2024-08-06": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "gpt-6-astra": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "gpt-5.1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high"
      ]
    },
    "gpt-4o-mini": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "o3-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 100000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gpt-daybreak-blue-latest": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "gpt-5.4-mini": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-5.6-luna": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "gpt-5.2": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-5.5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "gpt-4.1": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1047576,
      "contextScope": "combined",
      "maxOutputTokens": 32768
    },
    "gpt-4o-2024-11-20": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "gpt-4.1-mini": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1047576,
      "contextScope": "combined",
      "maxOutputTokens": 32768
    },
    "gpt-6-luna": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "gpt-5.3-chat-latest": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "gpt-image-1-mini": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true
    },
    "gpt-image-1.5": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true
    },
    "gpt-5.6-terra": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "gpt-4-turbo": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "gpt-daybreak-red-latest": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "o3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 100000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gpt-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 272000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gpt-5.6-sol": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "gpt-6-sol": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 922000,
      "contextScope": "input",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "o1-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 100000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    }
  },
  "anthropic": {
    "claude-haiku-4-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": []
    },
    "claude-opus-4-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "claude-sonnet-4-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": []
    },
    "claude-opus-5-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "claude-fable-5-1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "claude-opus-4-5-20251101": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "claude-opus-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "claude-fable-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "claude-opus-4-8": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "claude-sonnet-4-5-20250929": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": []
    },
    "claude-sonnet-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "claude-opus-4-6": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "max"
      ]
    },
    "claude-haiku-4-5-20251001": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": []
    },
    "claude-haiku-5-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "claude-sonnet-4-6": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "max"
      ]
    },
    "claude-sonnet-5-5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "claude-opus-4-7": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    }
  },
  "google": {
    "gemini-flash-latest": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gemma-4-31b-it": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "gemini-3.1-flash-image-preview": {
      "toolCalls": false,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 65536,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "high"
      ]
    },
    "lyria-3-pro-preview": {
      "toolCalls": false,
      "reasoning": false,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536
    },
    "gemini-2.5-flash-image": {
      "toolCalls": false,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "gemini-flash-lite-latest": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-embedding-2": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 8192,
      "contextScope": "combined",
      "maxOutputTokens": 1
    },
    "gemini-3.6-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gemma-4-26b-a4b-it": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "gemini-3-pro-image-preview": {
      "toolCalls": false,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "gemini-3.5-flash-lite": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-3.1-flash-image": {
      "toolCalls": false,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": [
        "minimal",
        "high"
      ]
    },
    "lyria-3-clip-preview": {
      "toolCalls": false,
      "reasoning": false,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536
    },
    "gemini-3.1-pro-preview": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-2.5-computer-use-preview-10-2025": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": []
    },
    "gemini-3.5-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-2.5-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "gemini-3-pro-image": {
      "toolCalls": false,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 65536,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": [
        "low",
        "high"
      ]
    },
    "gemini-2.5-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "gemini-3.1-flash-lite-image": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 65536,
      "contextScope": "combined",
      "maxOutputTokens": 4096,
      "reasoningEfforts": [
        "minimal",
        "high"
      ]
    },
    "deep-research-preview-04-2026": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "deep-research-max-preview-04-2026": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "gemini-3.7-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-3.1-pro-preview-customtools": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-3-flash-preview": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-3.8-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-3.5-live-translate-preview": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 16384,
      "contextScope": "combined",
      "maxOutputTokens": 32768
    },
    "gemini-2.5-flash-lite": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "gemini-embedding-001": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 2048,
      "contextScope": "combined",
      "maxOutputTokens": 1
    },
    "gemini-3.1-flash-lite-preview": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-3.1-flash-live-preview": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-4-argon": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "gemini-3.1-flash-lite": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high"
      ]
    }
  },
  "deepseek": {
    "deepseek-v4-flash-vision-exp": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 393216,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "deepseek-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 393216,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "deepseek-v4-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 393216,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "deepseek-v4-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 393216,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    }
  },
  "moonshotai": {
    "kimi-k3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 1048576,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "kimi-k2.7-code-highspeed": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144,
      "reasoningEfforts": []
    },
    "kimi-k2.6": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144,
      "reasoningEfforts": []
    },
    "kimi-k2.7-code": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144,
      "reasoningEfforts": []
    }
  },
  "alibaba": {
    "qwen-flash": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "qwen3.5-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3.7-max": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "qwen2-5-32b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwq-plus": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192,
      "reasoningEfforts": []
    },
    "qwen2-5-vl-72b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3-vl-plus": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "qwen3.5-27b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "deepseek-v4-flash-0731": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 384000,
      "reasoningEfforts": [
        "high",
        "max"
      ]
    },
    "qwen-max": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3-next-80b-a3b-thinking": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "qwen3.8-max": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "medium",
        "xhigh"
      ]
    },
    "kimi-k3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 1048576,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "qwen-plus-character-ja": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8192,
      "contextScope": "combined",
      "maxOutputTokens": 512
    },
    "qwen3.5-plus": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3-livetranslate-flash-realtime": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 53248,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "qwen2-5-72b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3-32b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "qwen-plus": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "qwen3.7-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 991808,
      "contextScope": "input",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "qwen3-max": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536
    },
    "qwen-omni-turbo-realtime": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 2048
    },
    "qwen3-coder-480b-a35b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536
    },
    "qwen-turbo": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "qwen3-coder-30b-a3b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536
    },
    "qwen3.8-omni-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "xhigh"
      ]
    },
    "qvq-max": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192,
      "reasoningEfforts": []
    },
    "qwen2-5-7b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3-omni-flash": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 65536,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "qwen-vl-max": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3-235b-a22b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "qwen3-vl-30b-a3b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "qwen3.5-122b-a10b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3.6-35b-a3b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3-next-80b-a3b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 32768
    },
    "qwen-vl-plus": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3.6-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3-coder-flash": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 65536
    },
    "qwen2-5-omni-7b": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 2048
    },
    "qwen-mt-plus": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 16384,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3-vl-235b-a22b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "qwen3-coder-plus": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 65536
    },
    "qwen2-5-14b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3.8-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "medium",
        "xhigh"
      ]
    },
    "qwen2-5-vl-7b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3.5-35b-a3b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3.6-max-preview": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen-mt-turbo": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 16384,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "qwen3.5-397b-a17b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3-8b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192,
      "reasoningEfforts": []
    },
    "glm-5.2": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "qwen-omni-turbo": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 2048
    },
    "qwen3-omni-flash-realtime": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 65536,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "qwen3-asr-flash": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 53248,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "qwen3.6-27b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3.6-plus": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen3-14b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192,
      "reasoningEfforts": []
    },
    "qwen3.7-plus": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "qwen-vl-ocr": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 34096,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    }
  },
  "mistral": {
    "open-mistral-nemo": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "codestral-latest": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "mistral-large-2411": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "mistral-nemo": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "mistral-medium-2508": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "mistral-large-latest": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "mistral-small-latest": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 256000,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "ministral-8b-2512": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "zai-glm-5-2": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "none",
        "high",
        "max"
      ]
    },
    "ministral-8b-latest": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "devstral-medium-latest": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "mistral-large-4": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 262144,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "open-mixtral-8x22b": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 64000,
      "contextScope": "combined",
      "maxOutputTokens": 64000
    },
    "devstral-2512": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "mistral-medium-2505": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 131072
    },
    "magistral-medium-latest": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "voxtral-small-2507": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 32000
    },
    "glm-5-2": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "none",
        "high",
        "max"
      ]
    },
    "labs-leanstral-1-5-1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "pixtral-12b": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "mistral-embed": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8000,
      "contextScope": "combined",
      "maxOutputTokens": 3072
    },
    "devstral-small-2505": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "mistral-small-2603": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 256000,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "devstral-medium-2507": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "voxtral-mini-latest": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false
    },
    "labs-devstral-small-2512": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 256000
    },
    "mistral-large-2512": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "devstral-latest": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "ministral-14b-2512": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "devstral-small-2507": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "pixtral-large-latest": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "voxtral-small-latest": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 32000
    },
    "open-mixtral-8x7b": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32000,
      "contextScope": "combined",
      "maxOutputTokens": 32000
    },
    "mistral-small-2506": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "zai-glm-5-3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "ministral-3b-2512": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "mistral-medium-2604": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "open-mistral-7b": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8000,
      "contextScope": "combined",
      "maxOutputTokens": 8000
    },
    "codestral-2508": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "ministral-3b-latest": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 128000
    },
    "mistral-medium-latest": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    }
  },
  "xai": {
    "grok-4.7": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 500000,
      "contextScope": "combined",
      "maxOutputTokens": 500000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "grok-4.3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 30000,
      "reasoningEfforts": [
        "none",
        "low",
        "medium",
        "high"
      ]
    },
    "grok-4.20-0309-reasoning": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 30000,
      "reasoningEfforts": []
    },
    "grok-4.5": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 500000,
      "contextScope": "combined",
      "maxOutputTokens": 500000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "grok-4.20-0309-non-reasoning": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 30000
    },
    "grok-build-0.1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 256000,
      "reasoningEfforts": []
    },
    "grok-4.20-multi-agent-0309": {
      "toolCalls": false,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 30000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "grok-4.6": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 500000,
      "contextScope": "combined",
      "maxOutputTokens": 500000,
      "reasoningEfforts": [
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    }
  },
  "zhipuai": {
    "glm-5v-turbo": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "glm-5.3-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "glm-5": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "glm-5.3-flashx": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "glm-5.2": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "high",
        "max"
      ]
    },
    "glm-5.1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "glm-5.3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "glm-4.5-air": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 98304,
      "reasoningEfforts": []
    },
    "glm-4.7-flashx": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "glm-4.5-flash": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 98304,
      "reasoningEfforts": []
    },
    "glm-4.7": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "glm-4.7-flash": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 200000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "glm-4.5v": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 64000,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "glm-4.6v-flash": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    },
    "glm-4.6": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "glm-4.5": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 98304,
      "reasoningEfforts": []
    },
    "glm-4.6v": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": []
    }
  },
  "minimax": {
    "minimax-m3": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 512000,
      "reasoningEfforts": []
    },
    "minimax-m2.1": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "minimax-m2.5": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "minimax-m2.7": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "minimax-m2.7-highspeed": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "minimax-m2": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "minimax-m2.5-highspeed": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    }
  },
  "cohere": {
    "command-r-08-2024": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4000
    },
    "north-mini-code-1-0": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "command-a-translate-08-2025": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8000,
      "contextScope": "combined",
      "maxOutputTokens": 8000
    },
    "tiny-aya-fire": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8000,
      "contextScope": "combined",
      "maxOutputTokens": 8000
    },
    "command-r7b-arabic-02-2025": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4000
    },
    "tiny-aya-earth": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8000,
      "contextScope": "combined",
      "maxOutputTokens": 8000
    },
    "command-a-plus-05-2026": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 64000,
      "reasoningEfforts": []
    },
    "command-a-03-2025": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 8000
    },
    "c4ai-aya-vision-32b": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 16000,
      "contextScope": "combined",
      "maxOutputTokens": 4000
    },
    "tiny-aya-global": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8000,
      "contextScope": "combined",
      "maxOutputTokens": 8000
    },
    "north-small-translate-09-2026": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 16000
    },
    "command-r7b-12-2024": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4000
    },
    "command-r-plus-08-2024": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4000
    },
    "command-a-vision-07-2025": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8000
    },
    "tiny-aya-water": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8000,
      "contextScope": "combined",
      "maxOutputTokens": 8000
    },
    "command-a-reasoning-08-2025": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 32000,
      "reasoningEfforts": []
    },
    "c4ai-aya-expanse-32b": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4000
    }
  },
  "meta": {
    "muse-spark-1.3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "muse-spark-1.1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "muse-spark-1.2": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "muse-spark-1.2-contributor": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    },
    "muse-wonder-1.0": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "muse-spark-1.3-contributor": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh"
      ]
    }
  },
  "nvidia": {
    "baai/bge-m3": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 8192,
      "contextScope": "combined",
      "maxOutputTokens": 1024
    },
    "poolside/laguna-xs-2.1": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "abacusai/dracarys-llama-3.1-70b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "z-ai/glm-5.3-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "z-ai/glm-5.2": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "z-ai/glm-5.3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "thinkingmachines/inkling": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "meta/llama-guard-4-12b": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "meta/muse-glimmer-30b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "max"
      ]
    },
    "meta/esmfold": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "meta/llama-3.3-70b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "meta/llama-3.2-90b-vision-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "meta/llama-4-maverick-17b-128e-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "meta/llama-3.1-8b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 16000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "meta/llama-3.2-11b-vision-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "meta/llama-3.2-1b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "meta/llama-3.2-3b-instruct": {
      "toolCalls": false,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 32000
    },
    "meta/llama-3.1-70b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "meta/esm2-650m": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "upstage/solar-10.7b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "bytedance/seed-oss-36b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 262000,
      "contextScope": "combined",
      "maxOutputTokens": 262000
    },
    "google/diffusiongemma-26b-a4b-it": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 250000,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "google/gemma-4-31b-it": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "google/gemma-2-2b-it": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "google/gemma-3-12b-it": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "google/gemma-3n-e2b-it": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "google/google-paligemma": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "google/gemma-3n-e4b-it": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "google/gemma-3-4b-it": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "minimaxai/minimax-m2.7": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 204800,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "minimaxai/minimax-m3": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "deepseek-ai/deepseek-v4-flash-0731": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 384000,
      "reasoningEfforts": [
        "none",
        "high",
        "max"
      ]
    },
    "deepseek-ai/deepseek-v4.1-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 384000,
      "reasoningEfforts": [
        "none",
        "low",
        "high",
        "max"
      ]
    },
    "deepseek-ai/deepseek-v4-pro-0813": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 384000,
      "reasoningEfforts": [
        "none",
        "high",
        "max"
      ]
    },
    "deepseek-ai/deepseek-v4-pro": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 393216,
      "reasoningEfforts": [
        "none",
        "high",
        "max"
      ]
    },
    "deepseek-ai/deepseek-v4-flash": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 393216,
      "reasoningEfforts": [
        "none",
        "high",
        "max"
      ]
    },
    "stepfun-ai/step-3.5-flash": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "stepfun-ai/step-3.7-flash": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": [
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "mistralai/mistral-nemotron": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "mistralai/mistral-7b-instruct-v0.3": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 65536,
      "contextScope": "combined",
      "maxOutputTokens": 65536
    },
    "mistralai/mistral-large-3-675b-instruct-2512": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144
    },
    "mistralai/magistral-small-2506": {
      "toolCalls": false,
      "reasoning": false,
      "structuredOutput": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "input",
      "maxOutputTokens": 32768
    },
    "mistralai/mistral-small-4-119b-2603": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "mistralai/mixtral-8x7b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "mistralai/mistral-medium-3.5-128b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": [
        "none",
        "high"
      ]
    },
    "mistralai/ministral-14b-instruct-2512": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "mistralai/mixtral-8x22b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 65536,
      "contextScope": "combined",
      "maxOutputTokens": 13108
    },
    "mistralai/mistral-medium-3-instruct": {
      "toolCalls": false,
      "reasoning": false,
      "structuredOutput": false,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "input",
      "maxOutputTokens": 32768
    },
    "moonshotai/kimi-k3": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": [
        "low",
        "high",
        "max"
      ]
    },
    "moonshotai/kimi-k2.6": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144,
      "reasoningEfforts": [
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max"
      ]
    },
    "sarvamai/sarvam-m": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "nvidia/nvidia-nemotron-nano-9b-v2": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "nvidia/llama-3.1-nemotron-ultra-253b-v1": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "nvidia/sparsedrive": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 131072,
      "reasoningEfforts": []
    },
    "nvidia/nemotron-3.5-lightning-30b-a3b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 262144,
      "reasoningEfforts": []
    },
    "nvidia/llama-nemotron-embed-vl-1b-v2": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 2048
    },
    "nvidia/nv-embedcode-7b-v1": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 2048
    },
    "nvidia/nemotron-voicechat": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "nvidia/bevformer": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "nvidia/llama-3.1-nemotron-nano-vl-8b-v1": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "nvidia/studiovoice": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "nvidia/nemotron-content-safety-reasoning-4b": {
      "toolCalls": false,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096,
      "reasoningEfforts": []
    },
    "nvidia/llama-3.1-nemotron-safety-guard-8b-v3": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "nvidia/nv-embed-v1": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 2048
    },
    "nvidia/synthetic-video-detector": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "maxOutputTokens": 4096
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 1000000,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 256000,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "nvidia/llama-3.1-nemotron-nano-8b-v1": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "nvidia/active-speaker-detection": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "maxOutputTokens": 4096
    },
    "nvidia/streampetr": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "nvidia/llama-nemotron-rerank-vl-1b-v2": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "nvidia/nemotron-mini-4b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "nvidia/cosmos-reason2-8b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 16384,
      "reasoningEfforts": []
    },
    "nvidia/nemotron-3-content-safety": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "nvidia/nemotron-3.5-super-vl-120b-a12b": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 1048576,
      "contextScope": "combined",
      "maxOutputTokens": 8192,
      "reasoningEfforts": []
    },
    "nvidia/llama-3.3-nemotron-super-49b-v1": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "nvidia/riva-translate-4b-instruct-v1.1": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "nvidia/nemotron-nano-12b-v2-vl": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 128000,
      "reasoningEfforts": []
    },
    "nvidia/nemotron-3.5-content-safety": {
      "toolCalls": false,
      "reasoning": true,
      "imageInput": true,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192,
      "reasoningEfforts": []
    },
    "nvidia/llama-3.3-nemotron-super-49b-v1.5": {
      "toolCalls": true,
      "reasoning": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "nvidia/llama-3_2-nemoretriever-300m-embed-v1": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 32768,
      "contextScope": "combined",
      "maxOutputTokens": 2048
    },
    "nvidia/gliner-pii": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "nvidia/usdcode": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "nvidia/usdvalidate": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "maxOutputTokens": 4096
    },
    "nvidia/llama-3.1-nemotron-70b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "nvidia/rerank-qa-mistral-4b": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 66536
    },
    "qwen/qwen3.5-122b-a10b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 65536,
      "reasoningEfforts": []
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 16384
    },
    "qwen/qwen3.5-397b-a17b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": true,
      "contextWindow": 262144,
      "contextScope": "combined",
      "maxOutputTokens": 8192,
      "reasoningEfforts": []
    },
    "qwen/qwen2.5-coder-32b-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "combined",
      "maxOutputTokens": 4096
    },
    "openai/whisper-large-v3": {
      "toolCalls": false,
      "reasoning": false,
      "imageInput": false,
      "maxOutputTokens": 4096
    },
    "openai/gpt-oss-20b": {
      "toolCalls": true,
      "reasoning": true,
      "structuredOutput": true,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 32768,
      "reasoningEfforts": [
        "low",
        "medium",
        "high"
      ]
    },
    "microsoft/phi-4-mini-instruct": {
      "toolCalls": true,
      "reasoning": false,
      "imageInput": false,
      "contextWindow": 131072,
      "contextScope": "combined",
      "maxOutputTokens": 8192
    },
    "microsoft/phi-4-multimodal-instruct": {
      "toolCalls": false,
      "reasoning": false,
      "structuredOutput": false,
      "imageInput": false,
      "contextWindow": 128000,
      "contextScope": "input",
      "maxOutputTokens": 16384
    }
  }
};
