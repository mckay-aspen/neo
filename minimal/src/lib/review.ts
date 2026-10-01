import type { Book } from './types';
import type { ReviewAnchor, ReviewData, ReviewEvent, ReviewThread, ResolvedAnchor, RichDocument, RichNode } from './review-types';

const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
const blockTypes = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'horizontalRule']);
const nodeTypes = new Set(['doc', ...blockTypes, 'text', 'listItem', 'hardBreak']);
const markTypes = new Set(['bold', 'italic', 'underline', 'strike', 'highlight', 'code', 'link']);
const encoder = new TextEncoder();
export const MAX_COMMENT_BYTES = 100_000;
function fail(message: string): never { throw new Error(`Review data: ${message}`); }
const record = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const wellFormed = (value: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unsupported fields are not allowed.');
}

function string(value: unknown, maximum: number, label: string, nonblank = false): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum || !wellFormed(value) || (nonblank && !value.trim())) {
    fail(`${label} is missing, invalid or too long.`);
  }
}

function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) fail('an identifier is invalid.');
}

function timestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string') fail('an event timestamp is invalid.');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) fail('an event timestamp must be an ISO timestamp.');
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1] ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59 || !Number.isFinite(Date.parse(value))) {
    fail('an event timestamp is not a real date and time.');
  }
}

function validateAnchor(value: unknown): ReviewAnchor {
  if (!record(value)) fail('the text anchor is invalid.');
  keys(value, ['start', 'end', 'quote', 'prefix', 'suffix']);
  string(value.quote, 20_000, 'The selected text');
  string(value.prefix, 64, 'The anchor prefix');
  string(value.suffix, 64, 'The anchor suffix');
  if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) ||
      (value.start as number) < 0 || (value.end as number) <= (value.start as number) ||
      (value.end as number) - (value.start as number) !== value.quote.length) {
    fail('anchor offsets must describe the selected text in UTF-16 units.');
  }
  return { start: value.start as number, end: value.end as number, quote: value.quote, prefix: value.prefix, suffix: value.suffix };
}

function safeHref(value: unknown): void {
  string(value, 2_048, 'The link', true);
  if (/[\u0000-\u0020\u007f-\u009f\s]/u.test(value)) fail('links cannot contain spaces or control characters.');
  let url: URL;
  try { url = new URL(value); } catch { fail('the link must be an absolute http, https or mailto URL.'); }
  if (!['http:', 'https:', 'mailto:'].includes(url.protocol) ||
      (url.protocol === 'mailto:' ? !url.pathname : !url.hostname)) {
    fail('only http, https and mailto links are allowed.');
  }
}

function attrs(value: unknown, allowed: string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (!record(value)) fail('formatting attributes are invalid.');
  keys(value, allowed);
  return value;
}

function validateMark(value: unknown): void {
  if (!record(value) || typeof value.type !== 'string' || !markTypes.has(value.type)) fail('this text formatting is not supported.');
  keys(value, ['type', 'attrs']);
  if (value.type === 'link') {
    const attributes = attrs(value.attrs, ['href', 'title', 'target', 'rel']);
    safeHref(attributes.href);
    if (attributes.title !== undefined && attributes.title !== null) string(attributes.title, 240, 'The link title');
    if (attributes.target !== undefined && attributes.target !== null &&
        !['_blank', '_self', '_parent', '_top'].includes(attributes.target as string)) fail('the link target is invalid.');
    if (attributes.rel !== undefined && attributes.rel !== null) {
      string(attributes.rel, 120, 'The link relationship');
      if (!/^[A-Za-z -]*$/.test(attributes.rel)) fail('the link relationship is invalid.');
    }
  } else if (value.type === 'highlight') {
    const attributes = attrs(value.attrs, ['color']);
    if (attributes.color !== undefined && attributes.color !== null &&
        (typeof attributes.color !== 'string' || !/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(attributes.color))) {
      fail('highlight colors must be hexadecimal colors.');
    }
  } else attrs(value.attrs, []);
}

function validateDocument(value: unknown): RichDocument {
  let nodes = 0;
  let textBytes = 0;
  const visit = (node: unknown, depth: number, parent?: string): void => {
    if (++nodes > 5_000 || depth > 20) fail('a message is too large or nested too deeply.');
    if (!record(node) || typeof node.type !== 'string' || !nodeTypes.has(node.type)) fail('this message element is not supported.');
    keys(node, ['type', 'text', 'attrs', 'marks', 'content']);
    if ((depth === 1) !== (node.type === 'doc')) fail('a message must have exactly one document root.');
    const attributes = attrs(node.attrs, node.type === 'heading' ? ['level'] : node.type === 'orderedList' ? ['start'] : node.type === 'codeBlock' ? ['language'] : []);
    if (node.type === 'heading' && attributes.level !== undefined && ![1, 2, 3].includes(attributes.level as number)) fail('heading levels must be between one and three.');
    if (node.type === 'orderedList' && attributes.start !== undefined &&
        (typeof attributes.start !== 'number' || !Number.isSafeInteger(attributes.start) || attributes.start < 1)) fail('a list start must be a positive safe integer.');
    if (node.type === 'codeBlock' && attributes.language !== undefined && attributes.language !== null) string(attributes.language, 80, 'The code language');
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks) || node.marks.length > 7 || !['text', 'hardBreak'].includes(node.type) || parent === 'codeBlock') fail('text formatting is invalid here.');
      const used = new Set<string>();
      for (const mark of node.marks) {
        validateMark(mark);
        const type = (mark as { type: string }).type;
        if (used.has(type)) fail('the same text formatting cannot be repeated.');
        used.add(type);
      }
    }
    if (node.type === 'text') {
      string(node.text, MAX_COMMENT_BYTES, 'The message text');
      if (!node.text.length || node.content !== undefined) fail('a text element must contain text only.');
      textBytes += encoder.encode(node.text).byteLength;
      if (textBytes > MAX_COMMENT_BYTES) fail('message text cannot exceed 100 KB.');
      return;
    }
    if (node.text !== undefined) fail('only text elements may contain a text field.');
    if (node.content !== undefined && !Array.isArray(node.content)) fail('message content must be a list of elements.');
    const children = (node.content ?? []) as unknown[];
    if (['hardBreak', 'horizontalRule'].includes(node.type) && children.length) fail('this message element cannot contain children.');
    if (['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(node.type) && !children.length) fail('a message block is empty.');
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      if (!record(child) || typeof child.type !== 'string') fail('a message element is invalid.');
      const allowed = node.type === 'paragraph' || node.type === 'heading' ? ['text', 'hardBreak'].includes(child.type)
        : node.type === 'codeBlock' ? child.type === 'text'
        : node.type === 'bulletList' || node.type === 'orderedList' ? child.type === 'listItem'
        : node.type === 'listItem' ? (index === 0 ? child.type === 'paragraph' : blockTypes.has(child.type))
        : node.type === 'doc' || node.type === 'blockquote' ? blockTypes.has(child.type)
        : false;
      if (!allowed) fail('the message contains an invalid block structure.');
      visit(child, depth + 1, node.type);
    }
  };
  visit(value, 1);
  return JSON.parse(JSON.stringify(value)) as RichDocument;
}

/** Plain semantic text, suitable for validation, previews and copy operations. */
export function richText(doc: RichNode): string {
  const visit = (node: RichNode): string => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'horizontalRule') return '\n';
    const separator = ['paragraph', 'heading', 'codeBlock'].includes(node.type) ? '' : '\n';
    return (node.content ?? []).map(visit).join(separator);
  };
  return visit(doc);
}

function validateEvent(value: unknown): ReviewEvent {
  if (!record(value)) fail('an event is invalid.');
  const base = ['id', 'threadId', 'at', 'actor', 'type'];
  identifier(value.id); identifier(value.threadId); timestamp(value.at);
  string(value.actor, 240, 'The reviewer name', true);
  if (Array.from(value.actor).length > 120) fail('the reviewer name cannot exceed 120 characters.');
  switch (value.type) {
    case 'thread_created': {
      keys(value, [...base, 'chapterId', 'anchor', 'kind', 'messageId', 'body', 'replacement']);
      identifier(value.chapterId); identifier(value.messageId); validateAnchor(value.anchor);
      if (!['comment', 'highlight', 'strikethrough', 'suggestion'].includes(value.kind as string)) fail('the annotation kind is invalid.');
      const body = validateDocument(value.body);
      if (!['highlight', 'strikethrough'].includes(value.kind as string) && !richText(body).trim()) fail('a comment or suggestion needs message text.');
      if (value.replacement !== undefined) {
        if (value.kind !== 'suggestion') fail('only suggestions may include replacement text.');
        string(value.replacement, 20_000, 'The suggested replacement');
      }
      break;
    }
    case 'reply_added':
    case 'message_edited': {
      keys(value, [...base, 'messageId', 'body']); identifier(value.messageId);
      if (!richText(validateDocument(value.body)).trim()) fail('a reply or edit needs message text.');
      break;
    }
    case 'message_deleted': keys(value, [...base, 'messageId']); identifier(value.messageId); break;
    case 'thread_resolved':
    case 'thread_reopened': keys(value, base); break;
    case 'thread_reanchored': keys(value, [...base, 'chapterId', 'anchor']); identifier(value.chapterId); validateAnchor(value.anchor); break;
    default: fail('this event type is not supported.');
  }
  return JSON.parse(JSON.stringify(value)) as ReviewEvent;
}

function derive(events: ReviewEvent[]): ReviewThread[] {
  const threads = new Map<string, ReviewThread>();
  const eventIds = new Set<string>();
  const messages = new Map<string, string>();
  for (const event of events) {
    if (eventIds.has(event.id)) fail('event identifiers must be unique.');
    eventIds.add(event.id);
    if (event.type === 'thread_created') {
      if (threads.has(event.threadId) || messages.has(event.messageId)) fail('thread and message identifiers must be unique.');
      threads.set(event.threadId, {
        id: event.threadId, chapterId: event.chapterId, anchor: { ...event.anchor }, kind: event.kind,
        ...(event.replacement !== undefined ? { replacement: event.replacement } : {}),
        author: event.actor, createdAt: event.at, updatedAt: event.at, status: 'open',
        messages: [{ id: event.messageId, author: event.actor, createdAt: event.at, body: event.body }],
      });
      messages.set(event.messageId, event.threadId);
      continue;
    }
    const thread = threads.get(event.threadId);
    if (!thread) fail('an event refers to a thread that does not exist yet.');
    if (event.type === 'reply_added') {
      if (messages.has(event.messageId)) fail('message identifiers must be unique.');
      thread.messages.push({ id: event.messageId, author: event.actor, createdAt: event.at, body: event.body });
      messages.set(event.messageId, event.threadId);
    } else if (event.type === 'message_edited' || event.type === 'message_deleted') {
      if (messages.get(event.messageId) !== event.threadId) fail('the message does not belong to this thread.');
      const message = thread.messages.find(item => item.id === event.messageId)!;
      if (message.deletedAt) fail('a deleted message cannot be changed again.');
      if (event.type === 'message_edited') { message.body = event.body; message.editedAt = event.at; }
      else message.deletedAt = event.at;
    } else if (event.type === 'thread_resolved') {
      if (thread.status !== 'open') fail('only an open thread can be resolved.');
      thread.status = 'resolved';
    } else if (event.type === 'thread_reopened') {
      if (thread.status !== 'resolved') fail('only a resolved thread can be reopened.');
      thread.status = 'open';
    } else if (event.type === 'thread_reanchored') {
      thread.anchor = { ...event.anchor }; thread.chapterId = event.chapterId;
    }
    thread.updatedAt = event.at;
  }
  return [...threads.values()];
}

export function validateReview(value: unknown): ReviewData {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.events) || value.events.length > 10_000) fail('the review format is invalid or exceeds 10,000 events.');
  keys(value, ['version', 'events']);
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { fail('review data must be ordinary JSON.'); }
  if (encoder.encode(encoded).byteLength > 8 * 1024 * 1024) fail('review history cannot exceed 8 MB.');
  const result: ReviewData = { version: 1, events: value.events.map(validateEvent) };
  derive(result.events);
  return result;
}

export function reviewThreads(review?: ReviewData): ReviewThread[] {
  return review ? derive(validateReview(review).events) : [];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function reviewFingerprint(review?: ReviewData): string {
  return canonical(review ?? { version: 1, events: [] });
}

/** Existing events are immutable; changes to discussion must append new events. */
export function assertReviewAppendOnly(previous?: ReviewData, next?: ReviewData): void {
  const oldEvents = previous?.events ?? [];
  const newEvents = next?.events ?? [];
  if (newEvents.length < oldEvents.length || oldEvents.some((event, index) => canonical(event) !== canonical(newEvents[index]))) {
    fail('existing review history cannot be removed or rewritten. Append a new event instead.');
  }
}

export function appendReviewEvent(book: Book, event: ReviewEvent): Book {
  const review = validateReview({ version: 1, events: [...(book.review?.events ?? []), event] });
  return { ...book, chapters: book.chapters.map(chapter => ({ ...chapter })), review };
}

function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
}

export function makeAnchor(text: string, start: number, end: number): ReviewAnchor {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length ||
      splitsSurrogate(text, start) || splitsSurrogate(text, end)) fail('select a complete, nonempty passage of text.');
  let prefixStart = Math.max(0, start - 64);
  let suffixEnd = Math.min(text.length, end + 64);
  if (splitsSurrogate(text, prefixStart)) prefixStart++;
  if (splitsSurrogate(text, suffixEnd)) suffixEnd--;
  return validateAnchor({ start, end, quote: text.slice(start, end), prefix: text.slice(prefixStart, start), suffix: text.slice(end, suffixEnd) });
}

/** Relocate only unchanged quoted text; context can distinguish repeated passages. */
export function resolveAnchor(text: string, anchor: ReviewAnchor): ResolvedAnchor | null {
  const valid = validateAnchor(anchor);
  let candidates = 0;
  let first = -1;
  let contextual = 0;
  let contextualPosition = -1;
  let start = text.indexOf(valid.quote);
  while (start !== -1) {
    if (!candidates) first = start;
    candidates++;
    if (text.slice(Math.max(0, start - valid.prefix.length), start) === valid.prefix &&
        text.slice(start + valid.quote.length, start + valid.quote.length + valid.suffix.length) === valid.suffix) {
      contextualPosition = start;
      if (++contextual > 1) return null;
    }
    start = text.indexOf(valid.quote, start + 1);
  }
  const position = contextual === 1 ? contextualPosition : candidates === 1 ? first : undefined;
  return position === undefined ? null : { start: position, end: position + valid.quote.length, state: position === valid.start ? 'exact' : 'moved' };
}
