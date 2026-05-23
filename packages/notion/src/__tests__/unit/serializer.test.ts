/**
 * Unit tests for property value serializer.
 *
 * This is the highest-value unit-test target — deterministic, no HTTP dependency,
 * and where most property mapping bugs live. Tests every variant of NotionPropertyValue.
 */

import { describe, expect, it } from 'vitest';
import { serializeProperties, serializePropertyValue } from '../../serializer.js';
import type { NotionProperties, NotionPropertyValue } from '../../types.js';

describe('serializePropertyValue', () => {
  it('serializes title', () => {
    const val: NotionPropertyValue = { type: 'title', content: 'My Page' };
    expect(serializePropertyValue(val)).toEqual({
      title: [{ text: { content: 'My Page' } }],
    });
  });

  it('serializes rich_text', () => {
    const val: NotionPropertyValue = { type: 'rich_text', content: 'Some text' };
    expect(serializePropertyValue(val)).toEqual({
      rich_text: [{ text: { content: 'Some text' } }],
    });
  });

  it('serializes number', () => {
    const val: NotionPropertyValue = { type: 'number', value: 42 };
    expect(serializePropertyValue(val)).toEqual({ number: 42 });
  });

  it('serializes number with zero', () => {
    const val: NotionPropertyValue = { type: 'number', value: 0 };
    expect(serializePropertyValue(val)).toEqual({ number: 0 });
  });

  it('serializes select', () => {
    const val: NotionPropertyValue = { type: 'select', name: 'Option A' };
    expect(serializePropertyValue(val)).toEqual({ select: { name: 'Option A' } });
  });

  it('serializes multi_select', () => {
    const val: NotionPropertyValue = { type: 'multi_select', names: ['A', 'B', 'C'] };
    expect(serializePropertyValue(val)).toEqual({
      multi_select: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
    });
  });

  it('serializes multi_select with empty array', () => {
    const val: NotionPropertyValue = { type: 'multi_select', names: [] };
    expect(serializePropertyValue(val)).toEqual({ multi_select: [] });
  });

  it('serializes date with start only', () => {
    const val: NotionPropertyValue = { type: 'date', start: '2026-01-15' };
    expect(serializePropertyValue(val)).toEqual({ date: { start: '2026-01-15' } });
  });

  it('serializes date with start and end', () => {
    const val: NotionPropertyValue = { type: 'date', start: '2026-01-15', end: '2026-01-20' };
    expect(serializePropertyValue(val)).toEqual({
      date: { start: '2026-01-15', end: '2026-01-20' },
    });
  });

  it('serializes checkbox true', () => {
    const val: NotionPropertyValue = { type: 'checkbox', checked: true };
    expect(serializePropertyValue(val)).toEqual({ checkbox: true });
  });

  it('serializes checkbox false', () => {
    const val: NotionPropertyValue = { type: 'checkbox', checked: false };
    expect(serializePropertyValue(val)).toEqual({ checkbox: false });
  });

  it('serializes url', () => {
    const val: NotionPropertyValue = { type: 'url', url: 'https://example.com' };
    expect(serializePropertyValue(val)).toEqual({ url: 'https://example.com' });
  });

  it('serializes email', () => {
    const val: NotionPropertyValue = { type: 'email', email: 'test@example.com' };
    expect(serializePropertyValue(val)).toEqual({ email: 'test@example.com' });
  });

  it('serializes relation', () => {
    const val: NotionPropertyValue = {
      type: 'relation',
      pageIds: ['page-id-1', 'page-id-2'],
    };
    expect(serializePropertyValue(val)).toEqual({
      relation: [{ id: 'page-id-1' }, { id: 'page-id-2' }],
    });
  });

  it('serializes relation with empty array', () => {
    const val: NotionPropertyValue = { type: 'relation', pageIds: [] };
    expect(serializePropertyValue(val)).toEqual({ relation: [] });
  });

  // v1.0.0 additions per §4.4 of brief-week5.md
  it('serializes status (v1.0.0 addition)', () => {
    const val: NotionPropertyValue = { type: 'status', name: 'In Progress' };
    expect(serializePropertyValue(val)).toEqual({ status: { name: 'In Progress' } });
  });

  it('serializes phone_number (v1.0.0 addition)', () => {
    const val: NotionPropertyValue = { type: 'phone_number', phone_number: '+1-555-0100' };
    expect(serializePropertyValue(val)).toEqual({ phone_number: '+1-555-0100' });
  });
});

describe('serializeProperties', () => {
  it('serializes a multi-property map', () => {
    const props: NotionProperties = {
      Name: { type: 'title', content: 'Test Page' },
      Priority: { type: 'select', name: 'High' },
      Done: { type: 'checkbox', checked: false },
    };
    const result = serializeProperties(props);
    expect(result).toEqual({
      Name: { title: [{ text: { content: 'Test Page' } }] },
      Priority: { select: { name: 'High' } },
      Done: { checkbox: false },
    });
  });

  it('serializes empty properties map', () => {
    expect(serializeProperties({})).toEqual({});
  });

  it('preserves Notion property name case exactly', () => {
    const props: NotionProperties = {
      'Status Column': { type: 'status', name: 'Done' },
    };
    const result = serializeProperties(props);
    expect(Object.keys(result)).toContain('Status Column');
  });
});
