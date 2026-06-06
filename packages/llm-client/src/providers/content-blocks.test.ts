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

import { describe, expect, it } from 'vitest';
import type { LlmContentBlock, LlmMessage } from '../types.js';
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
        source: { type: 'base64', mediaType: 'application/pdf', data: 'pdfbytes', filename: 'brief.pdf' },
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
