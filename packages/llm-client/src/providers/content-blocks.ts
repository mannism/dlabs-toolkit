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
 * v5.1.0: added file block support.
 *   - assertBlocksSupported() extended with fileRef: boolean support flag.
 *   - mapGeminiParts() emits fileData parts for { type:'file', ref } blocks.
 *   - mapOpenAIContent() emits input_file with file_id for PDF refs (OpenAI only).
 *   - mapAnthropicContent() emits document/image source.file_id for PDF+image refs.
 *   - File blocks whose ref.provider mismatches the receiving provider throw bad_request.
 *   - File blocks with ref.state !== 'active' throw bad_request (Gemini only for now).
 *
 * Never issue an SDK call if unsupported media is detected — guard must throw first.
 * All provider-specific mapper functions are exported so their callers in the per-provider
 * files can import them without adding any new inter-provider dependencies.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type OpenAI from 'openai';
import type { LlmContentBlock, LlmFileRef, LlmMessage } from '../types.js';
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
 *
 * v5.1.0: added fileRef flag for { type: 'file', ref } blocks.
 * When fileRef is false, any file block throws bad_request pre-flight.
 */
export interface BlockSupportMatrix {
  textBlock: boolean;
  imageBase64: boolean;
  imageUrl: boolean;
  documentBase64: boolean;
  /** Whether the provider supports { type: 'file', ref } blocks via Files API (v5.1.0+). */
  fileRef?: boolean;
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
      if (block.type === 'file') {
        // v5.1.0: file blocks require the provider to support Files API refs.
        if (!support.fileRef) {
          throw new LlmError({
            message:
              `[llm-client] Provider '${provider}' does not support { type: 'file', ref } blocks.` +
              ` Files API is not available for this provider. Use inline base64 content instead.`,
            provider,
            kind: 'bad_request',
            retryable: false,
          });
        }
        // Cross-provider ref detection: ref.provider must match the receiving provider.
        const ref: LlmFileRef = block.ref;
        if (ref.provider !== provider) {
          throw new LlmError({
            message: `[llm-client] LlmFileRef provider mismatch: ref is '${ref.provider}', client is '${provider}'.`,
            provider,
            kind: 'bad_request',
            retryable: false,
          });
        }
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
 *   file (v5.1.0) PDF       → { type: 'document', source: { type: 'file', file_id: ref.id } }
 *   file (v5.1.0) image/*   → { type: 'image', source: { type: 'file', file_id: ref.id } }
 *   file (v5.1.0) video/*   → throws bad_request — Anthropic does not support video inputs.
 *
 * Note: Anthropic image URL source requires the URL to be an HTTPS URL accessible to the
 * Anthropic API. The toolkit does not validate this — the API will return a clear error.
 *
 * Note on Files beta: file_id references require the betas: ['files-api-2025-04-14'] header
 * to be set on the API call. The Anthropic provider sets this on beta.files.upload() calls.
 * For message.create calls that reference uploaded files, the beta header must also be set.
 * The Anthropic provider in anthropic.ts handles this via the betas param on messages.create.
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
      continue;
    }

    if (block.type === 'file') {
      // v5.1.0: Anthropic Files beta — source.type 'file' with file_id.
      // PDF → document block; image/* → image block; video/* → bad_request.
      const ref: LlmFileRef = block.ref;
      const mt = ref.mediaType;

      if (mt === 'application/pdf') {
        // Anthropic file-sourced document: source.type 'file' with file_id.
        // Cast required because Anthropic SDK types may not yet expose the 'file' source
        // variant in the TypeScript definitions (Files beta).
        result.push({
          type: 'document',
          source: { type: 'file', file_id: ref.id } as unknown as Anthropic.Base64PDFSource,
        } as Anthropic.ContentBlockParam);
      } else if (
        mt === 'image/jpeg' ||
        mt === 'image/png' ||
        mt === 'image/gif' ||
        mt === 'image/webp'
      ) {
        // Anthropic file-sourced image: source.type 'file' with file_id.
        // Cast required because Anthropic SDK types may not yet expose the 'file' source
        // variant in the TypeScript definitions (Files beta).
        result.push({
          type: 'image',
          source: {
            type: 'file',
            file_id: ref.id,
          } as unknown as Anthropic.ImageBlockParam['source'],
        } as Anthropic.ContentBlockParam);
      } else {
        // video/* — Anthropic does not support video inputs.
        throw new LlmError({
          message:
            `[llm-client] Provider 'anthropic' does not support media type '${mt}' via Files API.` +
            ` Only 'application/pdf' and image/* are accepted by the Anthropic Files beta.`,
          provider: 'anthropic',
          kind: 'bad_request',
          retryable: false,
        });
      }
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
 *   file (v5.1.0)           → { type: 'input_file', file_id: ref.id } for application/pdf only.
 *                             Video and image refs throw bad_request — OpenAI Responses API
 *                             does not expose video input or Files API images as of v5.1.0.
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
      continue;
    }

    if (block.type === 'file') {
      // OpenAI Files API: only PDF via input_file.file_id is supported.
      // Video and image refs are rejected — OpenAI Responses API does not expose
      // video input or Files API images as of v5.1.0.
      const ref: LlmFileRef = block.ref;
      if (ref.mediaType !== 'application/pdf') {
        throw new LlmError({
          message:
            `[llm-client] Provider 'openai' does not support media type '${ref.mediaType}' via Files API.` +
            ` Only 'application/pdf' is accepted by the Responses API input_file item.`,
          provider: 'openai',
          kind: 'bad_request',
          retryable: false,
        });
      }
      result.push({
        type: 'input_file',
        file_id: ref.id,
      } as OpenAI.Responses.ResponseInputContent);
    }
  }

  return result;
}

// ─── Gemini mapper ────────────────────────────────────────────────────────────

/**
 * Part type subset for Gemini inlineData and fileData (v5.1.0+).
 * Matches the @google/genai Part type's field shapes.
 *
 * fileData: used for Files API references (video, large images, PDFs).
 *   fileUri: the Gemini resource name (e.g. 'files/abc123') — NOT a raw HTTPS URI.
 *   mimeType: the MIME type declared at upload time.
 */
export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string; mimeType: string };
}

/**
 * Maps an LlmContentBlock[] to Gemini Part[] objects.
 *
 * Mapping:
 *   { type: 'text' }        → { text }
 *   image.base64            → { inlineData: { mimeType: mediaType, data } }
 *   document.base64         → { inlineData: { mimeType: 'application/pdf', data } }
 *   file (v5.1.0)           → { fileData: { fileUri: ref.id, mimeType: ref.mediaType } }
 *                             Throws bad_request if ref.state !== 'active'.
 *
 * image.url is rejected before this function is called by assertBlocksSupported().
 * Gemini's inlineData does NOT accept URLs — only inline bytes (base64).
 *
 * file refs must be ACTIVE before mapping. assertBlocksSupported() validates the
 * cross-provider invariant; this function validates the state invariant.
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
      continue;
    }

    if (block.type === 'file') {
      // State guard: file must be active before use in a Gemini call.
      // For OpenAI/Anthropic this check is skipped — they always return active refs.
      if (block.ref.state !== 'active') {
        throw new LlmError({
          message:
            '[llm-client] File ref must be active before use. Call client.files.waitForActive() first.',
          provider: 'gemini',
          kind: 'bad_request',
          retryable: false,
        });
      }
      // fileUri is the Gemini resource name — e.g. 'files/abc123'.
      // Gemini's API accepts the name form directly as fileUri.
      result.push({
        fileData: {
          fileUri: block.ref.id,
          mimeType: block.ref.mediaType,
        },
      });
    }
  }

  return result;
}
