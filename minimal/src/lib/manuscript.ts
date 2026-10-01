import type { Book } from './types';

export function newBook(title = 'Untitled novel', author = ''): Book {
  return {
    id: crypto.randomUUID(),
    title: title.trim() || 'Untitled novel',
    author,
    description: '',
    goal: 80_000,
    updatedAt: new Date().toISOString(),
    revision: 0,
    chapters: [{ id: crypto.randomUUID(), title: 'Chapter 1', content: '' }],
    notes: '',
  };
}

/** Counts words in prose, treating internal apostrophes and hyphens as part of a word. */
export function words(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:[’'\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function totalWords(book: Book): number {
  return book.chapters.reduce((count, chapter) => count + words(chapter.content), 0);
}

/** Exports manuscript text only; private notes and the working description stay in the app. */
export function exportMarkdown(book: Book): string {
  const title = book.title.replace(/[\r\n]+/g, ' ');
  const author = book.author.replace(/[\r\n]+/g, ' ');
  const parts = [`# ${title}`];
  if (author) parts.push(`By ${author}`);
  for (const chapter of book.chapters) {
    parts.push(`## ${chapter.title.replace(/[\r\n]+/g, ' ')}`, chapter.content);
  }
  return `${parts.join('\n\n')}\n`;
}

/** Plain text and Markdown import. Level-two headings start chapters; formatting remains text. */
export function importMarkdown(text: string, filename = 'Untitled novel'): Book {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const book = newBook(filename.replace(/\.(md|markdown|txt)$/i, ''));
  let start = 0;
  while (start < lines.length && !lines[start].trim()) start++;
  const heading = lines[start]?.match(/^#\s+(.+)$/);
  if (heading) { book.title = heading[1].trim(); start++; }
  while (start < lines.length && !lines[start].trim()) start++;
  if (heading && /^By\s+\S/i.test(lines[start] ?? '')) {
    book.author = lines[start].replace(/^By\s+/i, '').trim();
    start++;
  }
  const chapters: Book['chapters'] = [];
  let title = 'Chapter 1';
  let body: string[] = [];
  let hasHeading = false;
  const commit = () => {
    const content = body.join('\n').replace(/^\n+|\n+$/g, '');
    if (hasHeading || content) chapters.push({ id: crypto.randomUUID(), title, content });
  };
  for (const line of lines.slice(start)) {
    const chapter = line.match(/^##\s+(.+)$/);
    if (chapter) {
      commit();
      title = chapter[1].trim();
      body = [];
      hasHeading = true;
    } else body.push(line);
  }
  commit();
  if (chapters.length) book.chapters = chapters;
  return book;
}
