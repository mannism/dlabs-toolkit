/**
 * Property value serializer for @diabolicallabs/notion.
 *
 * Maps the @diabolicallabs/notion discriminated-union NotionPropertyValue shape
 * to the Notion REST API property value object expected by @notionhq/client.
 *
 * Each variant of NotionPropertyValue maps to the corresponding CreatePageParameters
 * / UpdatePageParameters property shape. This is the highest-value testable unit
 * in the package — bugs here produce silent data corruption at the Notion API level.
 *
 * Reference: https://developers.notion.com/reference/page-property-values
 */

import type { NotionProperties, NotionPropertyValue } from './types.js';

/**
 * Serialize a single NotionPropertyValue to the Notion REST wire format.
 * The returned object can be spread directly into the `properties` map of a
 * CreatePageParameters or UpdatePageParameters call.
 */
export function serializePropertyValue(value: NotionPropertyValue): Record<string, unknown> {
  switch (value.type) {
    case 'title':
      return { title: [{ text: { content: value.content } }] };

    case 'rich_text':
      return { rich_text: [{ text: { content: value.content } }] };

    case 'number':
      return { number: value.value };

    case 'select':
      return { select: { name: value.name } };

    case 'multi_select':
      return { multi_select: value.names.map((name) => ({ name })) };

    case 'date':
      return {
        date: {
          start: value.start,
          ...(value.end !== undefined && { end: value.end }),
        },
      };

    case 'checkbox':
      return { checkbox: value.checked };

    case 'url':
      return { url: value.url };

    case 'email':
      return { email: value.email };

    case 'relation':
      return { relation: value.pageIds.map((id) => ({ id })) };

    case 'status':
      return { status: { name: value.name } };

    case 'phone_number':
      return { phone_number: value.phone_number };
  }
}

/**
 * Serialize a NotionProperties map to the shape expected by @notionhq/client.
 * Returns a plain object where each key is the property name and the value
 * is the serialized property object.
 */
export function serializeProperties(
  properties: NotionProperties
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(properties)) {
    result[key] = serializePropertyValue(value);
  }
  return result;
}
