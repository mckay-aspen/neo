import { describe, expect, test } from 'bun:test';
import { exportMarkdown, importMarkdown, newBook, totalWords, words } from './manuscript';

describe('manuscript tools', () => {
  test('counts prose without counting punctuation or private notes', () => {
    expect(words('  “Don’t stop,” she said. A well-lit room. 123. ')).toBe(8);
    expect(words('  … — ! ')).toBe(0);
    const book = newBook('Book');
    book.notes = 'These words stay private';
    book.chapters[0].content = 'Three little words';
    expect(totalWords(book)).toBe(3);
  });

  test('round-trips manuscript title, author, chapters and plain text', () => {
    const book = newBook('The long way home', 'A. Writer');
    book.chapters[0].title = 'The departure';
    book.chapters[0].content = 'The first line.\n\nA second paragraph.';
    book.chapters.push({ id: crypto.randomUUID(), title: 'The return', content: 'Home again.' });
    book.notes = 'A private ending';
    const markdown = exportMarkdown(book);
    const imported = importMarkdown(markdown);
    expect(imported.title).toBe(book.title);
    expect(imported.author).toBe(book.author);
    expect(imported.chapters.map(({ title, content }) => ({ title, content })))
      .toEqual(book.chapters.map(({ title, content }) => ({ title, content })));
    expect(markdown).not.toContain(book.notes);
    expect(imported.id).not.toBe(book.id);
    expect(imported.revision).toBe(0);
  });

  test('imports plain text and normalizes Windows line endings', () => {
    const imported = importMarkdown('\uFEFFFirst paragraph.\r\n\r\nSecond paragraph.', 'A story.txt');
    expect(imported.title).toBe('A story');
    expect(imported.chapters[0].content).toBe('First paragraph.\n\nSecond paragraph.');
  });

  test('retains empty chapters and any text before the first chapter heading', () => {
    const imported = importMarkdown('# Book\n\nPrologue text.\n\n## First\n\n## Second\n\nEnd.');
    expect(imported.chapters.map(chapter => chapter.content)).toEqual(['Prologue text.', '', 'End.']);
  });
});
