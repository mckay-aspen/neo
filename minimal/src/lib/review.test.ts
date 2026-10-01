import { describe, expect, test } from 'bun:test';
import { appendReviewEvent, assertReviewAppendOnly, makeAnchor, resolveAnchor, reviewThreads, richText, validateReview } from './review';
import type { ReviewData, ReviewEvent, RichDocument, RichNode } from './review-types';
import { newBook } from './manuscript';
import { cloneBook, validateBook } from './types';

const at = '2026-09-30T12:00:00.000Z';
const body = (text: string): RichDocument => ({ type: 'doc', content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }] });
const created = (patch: Partial<Extract<ReviewEvent, { type: 'thread_created' }>> = {}): ReviewEvent => ({
  id: 'event-1', type: 'thread_created', threadId: 'thread-1', chapterId: 'chapter-1',
  at, actor: 'Alex', anchor: makeAnchor('A quiet morning.', 2, 7), kind: 'comment', messageId: 'message-1', body: body('Keep this image.'), ...patch,
});
const stream = (...events: ReviewEvent[]): ReviewData => ({ version: 1, events });
const event = (id: string, type: 'thread_resolved' | 'thread_reopened'): ReviewEvent => ({ id, type, threadId: 'thread-1', at, actor: 'Sam' });
const withBody = (document: RichDocument) => stream(created({ body: document }));

describe('review threads and an immutable audit', () => {
  test('old manuscripts remain valid without review metadata', () => {
    const old = newBook('Existing manuscript');
    expect(validateBook(old).review).toBeUndefined();
    expect(reviewThreads()).toEqual([]);
    expect(reviewThreads({ version: 1, events: [] })).toEqual([]);
  });

  test('derives replies, edits, soft deletion, status and reanchoring while keeping originals', () => {
    const first = created();
    const review = stream(first,
      { id: 'event-2', type: 'reply_added', threadId: 'thread-1', messageId: 'message-2', actor: 'Sam', at, body: body('A reply') },
      { id: 'event-3', type: 'message_edited', threadId: 'thread-1', messageId: 'message-1', actor: 'Alex', at, body: body('Edited opening comment') },
      { id: 'event-4', type: 'message_deleted', threadId: 'thread-1', messageId: 'message-2', actor: 'Sam', at },
      event('event-5', 'thread_resolved'), event('event-6', 'thread_reopened'),
      { id: 'event-7', type: 'thread_reanchored', threadId: 'thread-1', chapterId: 'chapter-2', anchor: makeAnchor('Changed passage', 0, 7), at, actor: 'Alex' });
    const original = JSON.stringify(review);
    const [thread] = reviewThreads(review);
    expect(thread.status).toBe('open');
    expect(thread.chapterId).toBe('chapter-2');
    expect(thread.anchor.quote).toBe('Changed');
    expect(thread.messages.map(message => richText(message.body))).toEqual(['Edited opening comment', 'A reply']);
    expect(thread.messages[0].author).toBe('Alex');
    expect(thread.messages[0].editedAt).toBe(at);
    expect(thread.messages[1].deletedAt).toBe(at);
    thread.messages[0].body.content![0].content![0].text = 'External mutation';
    expect(JSON.stringify(review)).toBe(original);
    expect(richText((review.events[0] as Extract<ReviewEvent, { type: 'thread_created' }>).body)).toBe('Keep this image.');
  });

  test('append and clone keep nested review data independent', () => {
    const original = newBook('Book');
    const appended = appendReviewEvent(original, created());
    const copied = cloneBook(appended);
    expect(original.review).toBeUndefined();
    const first = copied.review!.events[0] as Extract<ReviewEvent, { type: 'thread_created' }>;
    first.body.content![0].content![0].text = 'Changed elsewhere';
    expect(richText((appended.review!.events[0] as typeof first).body)).toBe('Keep this image.');
  });

  test('history can be extended but never shortened or rewritten', () => {
    const first = stream(created());
    expect(() => assertReviewAppendOnly(first, stream(...first.events, event('next', 'thread_resolved')))).not.toThrow();
    expect(() => assertReviewAppendOnly(first, undefined)).toThrow('cannot be removed');
    expect(() => assertReviewAppendOnly(first, stream(created({ actor: 'Someone else' })))).toThrow('cannot be removed');
    const reordered = JSON.parse(JSON.stringify(first)) as ReviewData;
    reordered.events[0] = Object.fromEntries(Object.entries(reordered.events[0]).reverse()) as ReviewEvent;
    expect(() => assertReviewAppendOnly(first, reordered)).not.toThrow();
  });

  test('resolved threads may continue discussion with audited replies and edits', () => {
    expect(() => validateReview(stream(created(), event('resolved', 'thread_resolved'), {
      id: 'reply', threadId: 'thread-1', type: 'reply_added', messageId: 'message-2', at, actor: 'Sam', body: body('Following up'),
    }))).not.toThrow();
  });

  test('rejects nonexistent, duplicate or cross-thread referents and invalid transitions', () => {
    const reply: ReviewEvent = { id: 'reply', threadId: 'missing', type: 'reply_added', messageId: 'm2', at, actor: 'Sam', body: body('Hello') };
    expect(() => validateReview(stream(reply))).toThrow('does not exist');
    expect(() => validateReview(stream(created(), created()))).toThrow('unique');
    expect(() => validateReview(stream(created(), { ...reply, threadId: 'thread-1', messageId: 'message-1' }))).toThrow('unique');
    expect(() => validateReview(stream(created(), event('reopen', 'thread_reopened')))).toThrow('resolved');
    expect(() => validateReview(stream(created(), event('resolved', 'thread_resolved'), event('resolved-again', 'thread_resolved')))).toThrow('open');
    const second = created({ id: 'second-create', threadId: 'thread-2', messageId: 'message-2' });
    expect(() => validateReview(stream(created(), second, { id: 'delete', type: 'message_deleted', threadId: 'thread-2', messageId: 'message-1', at, actor: 'Sam' }))).toThrow('belong');
    expect(() => validateReview(stream(created(), { id: 'delete', type: 'message_deleted', threadId: 'thread-1', messageId: 'message-1', at, actor: 'Sam' },
      { id: 'edit', type: 'message_edited', threadId: 'thread-1', messageId: 'message-1', at, actor: 'Sam', body: body('Cannot resurrect') }))).toThrow('deleted');
  });
});

describe('conservative UTF-16 text anchoring', () => {
  test('resolves an exact selection and an unchanged passage shifted by editing', () => {
    const text = 'An old road led home.';
    const anchor = makeAnchor(text, 3, 11);
    expect(resolveAnchor(text, anchor)).toEqual({ start: 3, end: 11, state: 'exact' });
    expect(resolveAnchor(`Later: ${text}`, anchor)).toEqual({ start: 10, end: 18, state: 'moved' });
    expect(resolveAnchor('An new road led home.', anchor)).toBeNull();
  });

  test('uses exact context to distinguish duplicate passages and refuses ambiguity', () => {
    const text = 'First room. A quiet morning. Last room. A quiet morning. The end.';
    const start = text.lastIndexOf('quiet');
    const anchor = makeAnchor(text, start, start + 5);
    expect(resolveAnchor(text, anchor)?.start).toBe(start);
    expect(resolveAnchor('echo echo', makeAnchor('echo', 0, 4))).toBeNull();
    expect(resolveAnchor('changed quiet changed quiet changed', anchor)).toBeNull();
  });

  test('keeps offsets in UTF-16 without splitting emoji in selections or context', () => {
    const text = `${'😀'.repeat(33)}word${'😀'.repeat(33)}`;
    const anchor = makeAnchor(text, 66, 70);
    expect(anchor.prefix.length).toBe(64);
    expect(anchor.suffix.length).toBe(64);
    expect(resolveAnchor(`😀${text}`, anchor)).toEqual({ start: 68, end: 72, state: 'moved' });
    expect(makeAnchor('A😀B', 1, 3).quote).toBe('😀');
    expect(() => makeAnchor('A😀B', 1, 2)).toThrow('complete');
    expect(() => makeAnchor('A😀B', 2, 3)).toThrow('complete');
  });

  test('rejects invalid offsets and overlong selections', () => {
    expect(() => makeAnchor('Text', -1, 2)).toThrow();
    expect(() => makeAnchor('Text', 1, 1)).toThrow();
    expect(() => makeAnchor('Text', 1.5, 3)).toThrow();
    expect(() => makeAnchor('Text', 0, 8)).toThrow();
    expect(() => makeAnchor('x'.repeat(20_001), 0, 20_001)).toThrow('too long');
    expect(() => validateReview(stream(created({ anchor: { start: 0, end: 1, quote: '😀', prefix: '', suffix: '' } })))).toThrow('UTF-16');
  });

  test('stale anchors remain valid saved metadata after chapter text changes or removal', () => {
    const book = appendReviewEvent(newBook('Book'), created());
    book.chapters = [];
    expect(validateBook(book).review!.events).toHaveLength(1);
    expect(resolveAnchor('Completely replaced text', (book.review!.events[0] as Extract<ReviewEvent, { type: 'thread_created' }>).anchor)).toBeNull();
  });
});

describe('rich review security and limits', () => {
  test('supports rich text blocks and safe formatting, preserving TipTap null defaults', () => {
    const document: RichDocument = { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading', marks: [{ type: 'bold' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Linked words', marks: [{ type: 'link', attrs: { href: 'https://example.com/path', target: '_blank', rel: 'noopener noreferrer', title: null } }, { type: 'highlight', attrs: { color: null } }] }, { type: 'hardBreak' }, { type: 'text', text: 'Next line', marks: [{ type: 'italic' }, { type: 'underline' }, { type: 'strike' }] }] },
      { type: 'orderedList', attrs: { start: 2 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }] },
      { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted', marks: [{ type: 'code' }] }] }] },
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: '<script>as plain text</script>' }] }, { type: 'horizontalRule' },
    ] };
    const validated = validateReview(withBody(document));
    expect((validated.events[0] as Extract<ReviewEvent, { type: 'thread_created' }>).body).toEqual(document);
    expect(richText(document)).toContain('Linked words\nNext line');
    expect(richText(document)).toContain('<script>as plain text</script>');
  });

  test.each(['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', '//example.com', 'https:\n//example.com', 'vbscript:alert(1)', 'https://example.com/\u00A0', 'https://example.com/\u0085'])('rejects unsafe link %s', href => {
    const document = body('Click');
    document.content![0].content![0].marks = [{ type: 'link', attrs: { href } }];
    expect(() => validateReview(withBody(document))).toThrow();
  });

  test.each(['https://example.com', 'http://example.com', 'mailto:writer@example.com'])('accepts safe link %s', href => {
    const document = body('Link');
    document.content![0].content![0].marks = [{ type: 'link', attrs: { href } }];
    expect(() => validateReview(withBody(document))).not.toThrow();
  });

  test('rejects HTML nodes, unknown fields, injected attrs and invalid block structure', () => {
    expect(() => validateReview(withBody({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] }))).toThrow();
    expect(() => validateReview(withBody({ type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'alert(1)' } }] }))).toThrow('unsupported');
    expect(() => validateReview(withBody({ type: 'doc', content: [{ type: 'text', text: 'Missing paragraph' }] }))).toThrow('structure');
    expect(() => validateReview(withBody({ type: 'doc', content: [{ type: 'heading', attrs: { level: 9 } }] }))).toThrow('levels');
    expect(() => validateReview(withBody({ type: 'doc', content: [{ type: 'orderedList', attrs: { start: -1 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] }] }))).toThrow('positive');
    const mark = body('Text');
    mark.content![0].content![0].marks = [{ type: 'highlight', attrs: { color: 'url(javascript:alert(1))' } }];
    expect(() => validateReview(withBody(mark))).toThrow('hexadecimal');
  });

  test('requires semantic message text except for standalone highlight/strike annotations', () => {
    expect(() => validateReview(stream(created({ body: body('   ') })))).toThrow('needs message');
    expect(() => validateReview(stream(created({ kind: 'suggestion', body: body(''), replacement: 'New text' })))).toThrow('needs message');
    expect(() => validateReview(stream(created({ kind: 'highlight', body: body('') })))).not.toThrow();
    expect(() => validateReview(stream(created({ kind: 'strikethrough', body: body('') })))).not.toThrow();
  });

  test('bounds nesting, nodes, text, events and total history bytes', () => {
    let nested: RichNode = { type: 'paragraph', content: [{ type: 'text', text: 'Deep' }] };
    for (let index = 0; index < 20; index++) nested = { type: 'blockquote', content: [nested] };
    expect(() => validateReview(withBody({ type: 'doc', content: [nested] }))).toThrow('nested');
    expect(() => validateReview(withBody({ type: 'doc', content: Array.from({ length: 5_001 }, () => ({ type: 'paragraph' })) }))).toThrow('too large');
    expect(() => validateReview(withBody(body('😀'.repeat(26_000))))).toThrow('100 KB');
    expect(() => validateReview(withBody(body('x'.repeat(100_000))))).not.toThrow();
    expect(() => validateReview(withBody(body('x'.repeat(100_001))))).toThrow();
    expect(() => validateReview({ version: 1, events: Array.from({ length: 10_001 }, () => created()) })).toThrow('10,000');
    expect(() => validateReview({ version: 1, events: [created({ body: body('x'.repeat(8 * 1024 * 1024)) })] })).toThrow('8 MB');
  });

  test('validates real timestamps, actors, identifiers and well-formed Unicode', () => {
    expect(() => validateReview(stream(created({ at: '2026-02-30T12:00:00.000Z' })))).toThrow('real date');
    expect(() => validateReview(stream(created({ at: '2024-02-29T12:00:00+02:00' })))).not.toThrow();
    expect(() => validateReview(stream(created({ actor: ' ' })))).toThrow('reviewer');
    expect(() => validateReview(stream(created({ actor: '😀'.repeat(121) })))).toThrow();
    expect(() => validateReview(stream(created({ id: '../escape' })))).toThrow('identifier');
    expect(() => validateReview(withBody(body('\uD800')))).toThrow('invalid');
  });
});
