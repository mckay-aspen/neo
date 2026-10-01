export interface Chapter {
  id: string;
  title: string;
  content: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  description: string;
  goal: number;
  updatedAt: string;
  revision: number;
  chapters: Chapter[];
  notes: string;
}

export interface Library { books: Book[] }

export interface Version {
  id: string;
  createdAt: string;
  title: string;
  revision: number;
}

export type SaveState = 'saved' | 'saving' | 'error';

export interface StorageAdapter {
  loadLibrary(): Promise<Library>;
  saveBook(book: Book): Promise<Book>;
  trashBook(id: string): Promise<void>;
  listVersions(bookId: string): Promise<Version[]>;
  readVersion(bookId: string, versionId: string): Promise<Book>;
}

export function cloneBook(book: Book): Book {
  return { ...book, chapters: book.chapters.map(chapter => ({ ...chapter })) };
}

export function validateBook(value: unknown): Book {
  if (!value || typeof value !== 'object') throw new Error('The manuscript is not a valid book.');
  const book = value as Book;
  const strings = [book.id, book.title, book.author, book.description, book.updatedAt, book.notes];
  if (strings.some(field => typeof field !== 'string') || !book.id ||
      !Number.isSafeInteger(book.revision) || book.revision < 0 ||
      !Number.isSafeInteger(book.goal) || book.goal < 0 || book.goal > 10_000_000 ||
      !Array.isArray(book.chapters) || book.chapters.some(chapter =>
        !chapter || typeof chapter.id !== 'string' || !chapter.id ||
        typeof chapter.title !== 'string' || typeof chapter.content !== 'string') ||
      new Set(book.chapters.map(chapter => chapter.id)).size !== book.chapters.length) {
    throw new Error('The manuscript contains invalid or missing fields.');
  }
  const validId = (id: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(id);
  const characters = (text: string) => Array.from(text).length;
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
  if (!validId(book.id) || book.chapters.some(chapter => !validId(chapter.id))) {
    throw new Error('The manuscript contains an invalid identifier.');
  }
  if (!book.title.trim() || characters(book.title) > 240 || characters(book.author) > 240 ||
      book.chapters.some(chapter => characters(chapter.title) > 240)) {
    throw new Error('Titles and author names must be 240 characters or fewer; the manuscript title cannot be blank.');
  }
  if (book.chapters.length > 2_000 || bytes(book.description) > 100_000 ||
      bytes(book.notes) > 2_000_000 || book.updatedAt.length > 64 ||
      book.chapters.some(chapter => bytes(chapter.content) > 10 * 1024 * 1024) ||
      bytes(JSON.stringify(book, null, 2)) > 40 * 1024 * 1024) {
    throw new Error('This manuscript exceeds the supported size. Keep chapters below 10 MB, notes below 2 MB and the manuscript below 40 MB.');
  }
  return cloneBook(book);
}

export function validateLibrary(value: unknown): Library {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Library).books)) {
    throw new Error('The saved library could not be read. It has not been overwritten.');
  }
  const books = (value as Library).books.map(validateBook);
  if (new Set(books.map(book => book.id)).size !== books.length) {
    throw new Error('The saved library contains duplicate book identifiers.');
  }
  return { books };
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String(error.message);
  return typeof error === 'string' ? error : 'Your changes could not be saved. Please try again.';
}
