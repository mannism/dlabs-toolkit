/**
 * Tests for the shared content-blocks helpers (v4.2.0+).
 *
 * Coverage:
 *   - hasMultimodalContent(): detection of block arrays vs string messages
 *   - extractTextFromBlocks(): text-only extraction, drops image/document
 *   - assertBlocksSupported(): throws bad_request for unsupported block types
 *   - mapAnthropicContent(): block → Anthropic ContentBlockParam array
 *   - mapOpenAIContent(): block → Responses API content item array
 *   - mapGeminiParts(): block → Gemini Part array
 */

import { PartMediaResolutionLevel } from '@google/genai';
import { describe, expect, it } from 'vitest';
import type { LlmContentBlock, LlmFileRef, LlmMessage } from '../types.js';
import { LlmError } from '../types.js';
import {
  assertBlocksSupported,
  extractTextFromBlocks,
  hasMultimodalContent,
  mapAnthropicContent,
  mapGeminiParts,
  mapOpenAIContent,
} from './content-blocks.js';

// ─── hasMultimodalContent ──────────────────────────────────────────────────────

describe('hasMultimodalContent()', () => {
  it('returns false for all-string messages', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];
    expect(hasMultimodalContent(messages)).toBe(false);
  });

  it('returns true when any message has a block array', () => {
    const messages: LlmMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ];
    expect(hasMultimodalContent(messages)).toBe(true);
  });

  it('returns false for empty messages array', () => {
    expect(hasMultimodalContent([])).toBe(false);
  });
});

// ─── extractTextFromBlocks ─────────────────────────────────────────────────────

describe('extractTextFromBlocks()', () => {
  it('joins all text blocks', () => {
    const blocks: LlmContentBlock[] = [
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('Hello world');
  });

  it('silently drops image blocks', () => {
    const blocks: LlmContentBlock[] = [
      { type: 'text', text: 'Before' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc' } },
      { type: 'text', text: 'After' },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('BeforeAfter');
  });

  it('silently drops document blocks', () => {
    const blocks: LlmContentBlock[] = [
      { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: 'xyz' } },
      { type: 'text', text: 'Summary' },
    ];
    expect(extractTextFromBlocks(blocks)).toBe('Summary');
  });

  it('returns empty string for empty array', () => {
    expect(extractTextFromBlocks([])).toBe('');
  });
});

// ─── assertBlocksSupported ─────────────────────────────────────────────────────

describe('assertBlocksSupported()', () => {
  it('passes for all-string messages regardless of support matrix', () => {
    const messages: LlmMessage[] = [{ role: 'user', content: 'Hello' }];
    expect(() =>
      assertBlocksSupported(messages, 'testprovider', {
        textBlock: false,
        imageBase64: false,
        imageUrl: false,
        documentBase64: false,
      })
    ).not.toThrow();
  });

  it('passes for text block when textBlock is true', () => {
    const messages: LlmMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }];
    expect(() =>
      assertBlocksSupported(messages, 'testprovider', {
        textBlock: true,
        imageBase64: false,
        imageUrl: false,
        documentBase64: false,
      })
    ).not.toThrow();
  });

  it('throws bad_request for image.base64 when imageBase64 is false', () => {
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc' } },
        ],
      },
    ];
    expect(() =>
      assertBlocksSupported(messages, 'deepseek', {
        textBlock: true,
        imageBase64: false,
        imageUrl: false,
        documentBase64: false,
      })
    ).toThrowError(LlmError);

    try {
      assertBlocksSupported(messages, 'deepseek', {
        textBlock: true,
        imageBase64: false,
        imageUrl: false,
        documentBase64: false,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      const e = err as LlmError;
      expect(e.kind).toBe('bad_request');
      expect(e.retryable).toBe(false);
      expect(e.provider).toBe('deepseek');
      expect(e.message).toContain('image');
      expect(e.message).toContain('base64');
    }
  });

  it('throws bad_request for image.url when imageUrl is false', () => {
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.jpg' } }],
      },
    ];
    expect(() =>
      assertBlocksSupported(messages, 'gemini', {
        textBlock: true,
        imageBase64: true,
        imageUrl: false,
        documentBase64: true,
      })
    ).toThrowError(LlmError);
  });

  it('throws bad_request for document.base64 when documentBase64 is false', () => {
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfbytes' },
          },
        ],
      },
    ];
    expect(() =>
      assertBlocksSupported(messages, 'perplexity', {
        textBlock: true,
        imageBase64: false,
        imageUrl: false,
        documentBase64: false,
      })
    ).toThrowError(LlmError);
  });

  it('error message names provider and block/source type', () => {
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/img.jpg' } }],
      },
    ];
    try {
      assertBlocksSupported(messages, 'gemini', {
        textBlock: true,
        imageBase64: true,
        imageUrl: false,
        documentBase64: true,
      });
    } catch (err) {
      const e = err as LlmError;
      expect(e.message).toContain("Provider 'gemini'");
      expect(e.message).toContain('image');
      expect(e.message).toContain('url');
    }
  });
});

// ─── mapAnthropicContent ───────────────────────────────────────────────────────

describe('mapAnthropicContent()', () => {
  it('maps text block', () => {
    const blocks: LlmContentBlock[] = [{ type: 'text', text: 'Hello' }];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'text', text: 'Hello' });
  });

  it('maps image.base64 block', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc123' },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
    });
  });

  it('maps image.url block', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/photo.jpg' },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/photo.jpg' },
    });
  });

  it('maps document.base64 block', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfbytes' },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'pdfbytes' },
    });
  });

  it('maps mixed blocks in order', () => {
    const blocks: LlmContentBlock[] = [
      { type: 'text', text: 'Describe this image.' },
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' },
      },
      {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfdatahere' },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ type: 'text' });
    expect(result[1]).toMatchObject({ type: 'image' });
    expect(result[2]).toMatchObject({ type: 'document' });
  });
});

// ─── mapOpenAIContent ──────────────────────────────────────────────────────────

describe('mapOpenAIContent()', () => {
  it('maps text block to input_text', () => {
    const blocks: LlmContentBlock[] = [{ type: 'text', text: 'Hello' }];
    const result = mapOpenAIContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'input_text', text: 'Hello' });
  });

  it('maps image.base64 to input_image with data URL', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc123' },
      },
    ];
    const result = mapOpenAIContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,abc123',
      detail: 'auto',
    });
  });

  it('maps image.url to input_image with URL', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/photo.jpg' },
      },
    ];
    const result = mapOpenAIContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'input_image',
      image_url: 'https://example.com/photo.jpg',
      detail: 'auto',
    });
  });

  it('respects detail: high on base64 image', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc' },
        detail: 'high',
      },
    ];
    const result = mapOpenAIContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'input_image',
      image_url: 'data:image/jpeg;base64,abc',
      detail: 'high',
    });
  });

  it('respects detail: low on url image', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/img.jpg' },
        detail: 'low',
      },
    ];
    const result = mapOpenAIContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'input_image',
      image_url: 'https://example.com/img.jpg',
      detail: 'low',
    });
  });

  it('defaults detail to auto when omitted', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.com/img.jpg' },
      },
    ];
    const result = mapOpenAIContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'input_image',
      image_url: 'https://example.com/img.jpg',
      detail: 'auto',
    });
  });

  it('maps document.base64 to input_file with data URI and default filename', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfbytes' },
      },
    ];
    const result = mapOpenAIContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'input_file',
      filename: 'document.pdf',
      file_data: 'data:application/pdf;base64,pdfbytes',
    });
  });

  it('maps document.base64 with explicit filename', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'document',
        source: {
          type: 'base64',
          mediaType: 'application/pdf',
          data: 'pdfbytes',
          filename: 'brief.pdf',
        },
      },
    ];
    const result = mapOpenAIContent(blocks);
    expect(result[0]).toMatchObject({
      type: 'input_file',
      filename: 'brief.pdf',
      file_data: 'data:application/pdf;base64,pdfbytes',
    });
  });
});

// ─── mapGeminiParts ────────────────────────────────────────────────────────────

describe('mapGeminiParts()', () => {
  it('maps text block to { text }', () => {
    const blocks: LlmContentBlock[] = [{ type: 'text', text: 'Hello Gemini' }];
    const result = mapGeminiParts(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ text: 'Hello Gemini' });
  });

  it('maps image.base64 to inlineData', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' },
      },
    ];
    const result = mapGeminiParts(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      inlineData: { mimeType: 'image/png', data: 'pngdata' },
    });
  });

  it('maps document.base64 to inlineData PDF', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfdatahere' },
      },
    ];
    const result = mapGeminiParts(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      inlineData: { mimeType: 'application/pdf', data: 'pdfdatahere' },
    });
  });

  it('does not map image.url (guard must run before this function)', () => {
    // mapGeminiParts does not throw for image.url — it skips it (the guard fires first).
    // This test documents the expectation that assertBlocksSupported is the rejection path.
    const blocks: LlmContentBlock[] = [
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.jpg' } },
    ];
    const result = mapGeminiParts(blocks);
    // image.url block is skipped by mapGeminiParts (guard is the rejection point)
    expect(result).toHaveLength(0);
  });
});

// ─── mapGeminiParts — mediaResolution (v6.7.0) ────────────────────────────────

describe('mapGeminiParts() — mediaResolution (v6.7.0)', () => {
  it('image low → MEDIA_RESOLUTION_LOW', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' },
        mediaResolution: 'low',
      },
    ];
    const result = mapGeminiParts(blocks);
    expect(result[0]?.mediaResolution).toEqual({
      level: PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW,
    });
  });

  it('document medium → MEDIA_RESOLUTION_MEDIUM', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfdata' },
        mediaResolution: 'medium',
      },
    ];
    const result = mapGeminiParts(blocks);
    expect(result[0]?.mediaResolution).toEqual({
      level: PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM,
    });
  });

  it('file high → MEDIA_RESOLUTION_HIGH on fileData part', () => {
    const ref: LlmFileRef = {
      id: 'files/abc123',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
      provider: 'gemini',
      mediaType: 'video/mp4',
      sizeBytes: 1024,
      state: 'active',
    };
    const blocks: LlmContentBlock[] = [{ type: 'file', ref, mediaResolution: 'high' }];
    const result = mapGeminiParts(blocks);
    expect(result[0]?.fileData).toMatchObject({ fileUri: ref.uri });
    expect(result[0]?.mediaResolution).toEqual({
      level: PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH,
    });
  });

  it('image ultra_high → MEDIA_RESOLUTION_ULTRA_HIGH', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' },
        mediaResolution: 'ultra_high',
      },
    ];
    const result = mapGeminiParts(blocks);
    expect(result[0]?.mediaResolution).toEqual({
      level: PartMediaResolutionLevel.MEDIA_RESOLUTION_ULTRA_HIGH,
    });
  });

  it('omits mediaResolution when unset', () => {
    const blocks: LlmContentBlock[] = [
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' } },
    ];
    const result = mapGeminiParts(blocks);
    expect(result[0]?.mediaResolution).toBeUndefined();
  });

  it('document ultra_high throws bad_request pre-flight (image-only)', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfdata' },
        mediaResolution: 'ultra_high',
      },
    ];
    expect(() => mapGeminiParts(blocks)).toThrow(LlmError);
    try {
      mapGeminiParts(blocks);
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      const e = err as LlmError;
      expect(e.kind).toBe('bad_request');
      expect(e.retryable).toBe(false);
      expect(e.provider).toBe('gemini');
      expect(e.message).toContain('ultra_high');
      expect(e.message).toContain('image-only');
    }
  });
});

// ─── mapOpenAIContent / mapAnthropicContent ignore block.mediaResolution ──────

describe('mapOpenAIContent() / mapAnthropicContent() ignore block.mediaResolution (v6.7.0)', () => {
  it('mapOpenAIContent: image block maps identically with or without mediaResolution', () => {
    const withoutRes: LlmContentBlock[] = [
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' } },
    ];
    const withRes: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/png', data: 'pngdata' },
        mediaResolution: 'high',
      },
    ];
    expect(mapOpenAIContent(withRes)).toEqual(mapOpenAIContent(withoutRes));
  });

  it('mapAnthropicContent: image block maps identically with or without mediaResolution', () => {
    const withoutRes: LlmContentBlock[] = [
      { type: 'image', source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc123' } },
    ];
    const withRes: LlmContentBlock[] = [
      {
        type: 'image',
        source: { type: 'base64', mediaType: 'image/jpeg', data: 'abc123' },
        mediaResolution: 'high',
      },
    ];
    expect(mapAnthropicContent(withRes)).toEqual(mapAnthropicContent(withoutRes));
  });
});

// ─── mapAnthropicContent — file blocks (v5.1.0) ───────────────────────────────

describe('mapAnthropicContent() — file blocks (v5.1.0)', () => {
  it('maps application/pdf file ref to Anthropic document block with source.type file', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file_pdf_abc',
          uri: 'file_pdf_abc',
          provider: 'anthropic',
          mediaType: 'application/pdf',
          sizeBytes: 1024,
          state: 'active',
        },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'document',
      source: { type: 'file', file_id: 'file_pdf_abc' },
    });
  });

  it('maps image/jpeg file ref to Anthropic image block with source.type file', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file_img_xyz',
          uri: 'file_img_xyz',
          provider: 'anthropic',
          mediaType: 'image/jpeg',
          sizeBytes: 2048,
          state: 'active',
        },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'image',
      source: { type: 'file', file_id: 'file_img_xyz' },
    });
  });

  it('maps image/png file ref to Anthropic image block', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file_png_001',
          uri: 'file_png_001',
          provider: 'anthropic',
          mediaType: 'image/png',
          sizeBytes: 512,
          state: 'active',
        },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'image' });
  });

  it('maps image/gif file ref to Anthropic image block', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file_gif_002',
          uri: 'file_gif_002',
          provider: 'anthropic',
          mediaType: 'image/gif',
          sizeBytes: 512,
          state: 'active',
        },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'image' });
  });

  it('maps image/webp file ref to Anthropic image block', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file_webp_003',
          uri: 'file_webp_003',
          provider: 'anthropic',
          mediaType: 'image/webp',
          sizeBytes: 512,
          state: 'active',
        },
      },
    ];
    const result = mapAnthropicContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: 'image' });
  });

  it('throws bad_request for video/mp4 file ref (Anthropic does not support video)', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file_vid_mp4',
          uri: 'file_vid_mp4',
          provider: 'anthropic',
          mediaType: 'video/mp4',
          sizeBytes: 5_000_000,
          state: 'active',
        },
      },
    ];
    expect(() => mapAnthropicContent(blocks)).toThrow(
      expect.objectContaining({
        name: 'LlmError',
        kind: 'bad_request',
        retryable: false,
      })
    );
  });
});

// ─── mapOpenAIContent — file blocks (v5.1.0) ──────────────────────────────────

describe('mapOpenAIContent() — file blocks (v5.1.0)', () => {
  it('maps application/pdf file ref to OpenAI input_file with file_id', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file-oai-pdf-123',
          uri: 'file-oai-pdf-123',
          provider: 'openai',
          mediaType: 'application/pdf',
          sizeBytes: 1024,
          state: 'active',
        },
      },
    ];
    const result = mapOpenAIContent(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'input_file',
      file_id: 'file-oai-pdf-123',
    });
  });

  it('throws bad_request for video/mp4 file ref (OpenAI does not support video via Files API)', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file-oai-vid-456',
          uri: 'file-oai-vid-456',
          provider: 'openai',
          mediaType: 'video/mp4',
          sizeBytes: 5_000_000,
          state: 'active',
        },
      },
    ];
    expect(() => mapOpenAIContent(blocks)).toThrow(
      expect.objectContaining({
        name: 'LlmError',
        kind: 'bad_request',
        retryable: false,
        message: expect.stringContaining("'openai' does not support media type 'video/mp4'"),
      })
    );
  });

  it('throws bad_request for image/jpeg file ref (OpenAI does not support image Files API refs)', () => {
    const blocks: LlmContentBlock[] = [
      {
        type: 'file',
        ref: {
          id: 'file-oai-img-789',
          uri: 'file-oai-img-789',
          provider: 'openai',
          mediaType: 'image/jpeg',
          sizeBytes: 1024,
          state: 'active',
        },
      },
    ];
    expect(() => mapOpenAIContent(blocks)).toThrow(
      expect.objectContaining({
        name: 'LlmError',
        kind: 'bad_request',
      })
    );
  });
});
