/**
 * Shared helpers for mapping LlmContentBlock[] to provider-specific request shapes.
 *
 * Responsibilities:
 *   - hasMultimodalContent()      — detect whether any message carries block content.
 *   - extractTextFromBlocks()     — collapse a block array to a plain string (for system param
 *                                   coercion and provider-specific text extraction).
 *   - assertBlocksSupported()     — pre-flight guard; throws bad_request before any SDK call
 *                                   if the message set contains unsupported block/source types.
 *   - mapAnthropicContent()       — map LlmContentBlock[] → Anthropic.MessageParam['content'].
 *   - mapOpenAIContent()          — map LlmContentBlock[] → OpenAI Responses API content items.
 *   - mapGeminiParts()            — map LlmContentBlock[] → @google/genai Part[].
 *
 * Never issue an SDK call if unsupported media is detected — guard must throw first.
 * All provider-specific mapper functions are exported so their callers in the per-provider
 * files can import them without adding any new inter-provider dependencies.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { LlmContentBlock, LlmMessage } from '../types.js';
import { LlmError } from '../types.js';

// ─── Detection helpers ────────────────────────────────────────────────────────

/**
 * Returns true if any message in the array has an LlmContentBlock[] content value.
 * String-only messages always return false.
 */
export function hasMultimodalContent(messages: LlmMessage[]): boolean {
  return messages.some((m) => Array.isArray(m.content));
}

/**
 * Extracts only the text from an LlmContentBlock[] array, concatenating all text blocks.
 * Used when a provider parameter accepts only a string (e.g. Anthropic system param in v4.2.0).
 * Non-text blocks are silently ignored — callers document this behavior with a comment.
 */
export function extractTextFromBlocks(blocks: LlmContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<LlmContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

// ─── Pre-flight guard ─────────────────────────────────────────────────────────

/**
 * Describes which block/source combinations a provider supports.
 * All booleans default to false when omitted.
 */
export interface BlockSupportMatrix {
  textBlock: boolean;
  imageBase64: boolean;
  imageUrl: boolean;
  documentBase64: boolean;
}

/**
 * Throws LlmError({ kind: 'bad_request', retryable: false }) if any message in the
 * array contains an LlmContentBlock that is not in the provider's support matrix.
 *
 * Must be called before any SDK invocation — the error must fire before the request
 * leaves the process.
 *
 * Only inspects messages with LlmContentBlock[] content — string content is skipped.
 */
export function assertBlocksSupported(
  messages: LlmMessage[],
  provider: string,
  support: BlockSupportMatrix
): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'text') {
        if (!support.textBlock) {
          throwUnsupportedBlock(provider, block.type, 'text');
        }
        continue;
      }
      if (block.type === 'image') {
        if (block.source.type === 'base64' && !support.imageBase64) {
          throwUnsupportedBlock(provider, 'image', 'base64');
        }
        if (block.source.type === 'url' && !support.imageUrl) {
          throwUnsupportedBlock(provider, 'image', 'url');
        }
        continue;
      }
      if (block.type === 'document') {
        if (block.source.type === 'base64' && !support.documentBase64) {
          throwUnsupportedBlock(provider, 'document', 'base64');
        }
        continue;
      }
    }
  }
}

function throwUnsupportedBlock(provider: string, blockType: string, sourceType: string): never {
  throw new LlmError({
    message:
      `[llm-client] Provider '${provider}' does not support ${blockType} content` +
      ` with source '${sourceType}' in LlmMessage.content.` +
      ` Use a supported provider/model or convert the attachment to text before calling this provider.`,
    provider,
    kind: 'bad_request',
    retryable: false,
  });
}

// ─── Anthropic mapper ─────────────────────────────────────────────────────────

/**
 * Maps an LlmContentBlock[] to Anthropic's MessageParam content type.
 *
 * Mapping:
 *   { type: 'text' }        → { type: 'text', text }
 *   image.base64            → { type: 'image', source: { type: 'base64', media_type, data } }
 *   image.url               → { type: 'image', source: { type: 'url', url } }
 *   document.base64         → { type: 'document', source: { type: 'base64', media_type, data } }
 *
 * Note: Anthropic image URL source requires the URL to be an HTTPS URL accessible to the
 * Anthropic API. The toolkit does not validate this — the API will return a clear error.
 */
export function mapAnthropicContent(blocks: LlmContentBlock[]): Anthropic.ContentBlockParam[] {
  const result: Anthropic.ContentBlockParam[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      result.push({ type: 'text', text: block.text });
      continue;
    }

    if (block.type === 'image') {
      if (block.source.type === 'base64') {
        result.push({
          type: 'image',
          source: {
            type: 'base64',
            // Anthropic SDK uses media_type (snake_case); toolkit uses mediaType (camelCase).
            media_type: block.source.mediaType as Anthropic.Base64ImageSource['media_type'],
            data: block.source.data,
          },
        });
      } else {
        // block.source.type === 'url'
        result.push({
          type: 'image',
          source: {
            type: 'url',
            url: block.source.url,
          },
        } as Anthropic.ContentBlockParam);
      }
      continue;
    }

    if (block.type === 'document') {
      // Anthropic document block — source.type 'base64' only in v4.2.0.
      result.push({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: block.source.data,
        },
      } as Anthropic.ContentBlockParam);
    }
  }

  return result;
}

// ─── OpenAI Responses API mapper ──────────────────────────────────────────────

/**
 * Maps an LlmContentBlock[] to OpenAI Responses API content items.
 *
 * Mapping:
 *   { type: 'text' }        → { type: 'input_text', text }
 *   image.base64            → { type: 'input_image', image_url: 'data:<mediaType>;base64,<data>', detail: 'auto' }
 *   image.url               → { type: 'input_image', image_url: url, detail: 'auto' }
 *   document.base64         → { type: 'input_file', filename, file_data: 'data:application/pdf;base64,<data>' }
 *
 * Note on detail: OpenAI detail accepts 'low' | 'high' | 'original' | 'auto'.
 * Hardcoded to 'auto' in v4.2.0; surfacing caller control is a follow-up item.
 *
 * Note on input_file.filename: REQUIRED by the Responses API — a 400 is returned without it.
 * Verified via live smoke test 2026-06-06: omitting filename → HTTP 400 "Missing required parameter";
 * including filename → HTTP 200. Defaults to 'document.pdf' when LlmContentBlock.source.filename
 * is not supplied by the caller.
 */
export function mapOpenAIContent(
  blocks: LlmContentBlock[]
): OpenAI.Responses.ResponseInputContent[] {
  const result: OpenAI.Responses.ResponseInputContent[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      result.push({ type: 'input_text', text: block.text });
      continue;
    }

    if (block.type === 'image') {
      if (block.source.type === 'base64') {
        const dataUrl = `data:${block.source.mediaType};base64,${block.source.data}`;
        result.push({
          type: 'input_image',
          image_url: dataUrl,
          detail: 'auto',
        } as OpenAI.Responses.ResponseInputContent);
      } else {
        // block.source.type === 'url'
        result.push({
          type: 'input_image',
          image_url: block.source.url,
          detail: 'auto',
        } as OpenAI.Responses.ResponseInputContent);
      }
      continue;
    }

    if (block.type === 'document') {
      const dataUrl = `data:application/pdf;base64,${block.source.data}`;
      result.push({
        type: 'input_file',
        filename: block.source.filename ?? 'document.pdf',
        file_data: dataUrl,
      } as OpenAI.Responses.ResponseInputContent);
    }
  }

  return result;
}

// ─── Gemini mapper ────────────────────────────────────────────────────────────

/**
 * Part type subset for Gemini inlineData.
 * Matches the @google/genai Part type's inlineData field shape.
 */
export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

/**
 * Maps an LlmContentBlock[] to Gemini Part[] objects.
 *
 * Mapping:
 *   { type: 'text' }        → { text }
 *   image.base64            → { inlineData: { mimeType: mediaType, data } }
 *   document.base64         → { inlineData: { mimeType: 'application/pdf', data } }
 *
 * image.url is rejected before this function is called by assertBlocksSupported().
 * Gemini's inlineData does NOT accept URLs — only inline bytes (base64).
 */
export function mapGeminiParts(blocks: LlmContentBlock[]): GeminiPart[] {
  const result: GeminiPart[] = [];

  for (const block of blocks) {
    if (block.type === 'text') {
      result.push({ text: block.text });
      continue;
    }

    if (block.type === 'image') {
      if (block.source.type === 'base64') {
        result.push({
          inlineData: {
            mimeType: block.source.mediaType,
            data: block.source.data,
          },
        });
        // image.url is guarded by assertBlocksSupported before this is called
      }
      continue;
    }

    if (block.type === 'document') {
      result.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: block.source.data,
        },
      });
    }
  }

  return result;
}
