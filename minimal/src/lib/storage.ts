import { invoke } from '@tauri-apps/api/core';
import { validateJournal, type DraftJournal, type JournalEntry } from './journal';
import { cloneBook, validateBook, validateLibrary, type Book, type Library, type StorageAdapter, type Version } from './types';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const PREVIEW_STORAGE_KEY = 'neo-minimal.browser-library.v1';
export const JOURNAL_KEY = `neo-minimal.${isDesktop ? 'desktop' : 'browser'}.drafts.v1`;

interface PreviewEnvelope {
  format: 1;
  books: Book[];
  versions: Record<string, { info: Version; book: Book }[]>;
  trash: Book[];
}

/** Browser preview only. The packaged desktop app persists through Rust commands. */
export class BrowserStorageAdapter implements StorageAdapter {
  constructor(private storage: Storage) {}

  private read(): PreviewEnvelope {
    const raw = this.storage.getItem(PREVIEW_STORAGE_KEY);
    if (!raw) return { format: 1, books: [], versions: {}, trash: [] };
    let value: PreviewEnvelope;
    try { value = JSON.parse(raw) as PreviewEnvelope; }
    catch { throw new Error('Browser preview storage is damaged. The original data has been preserved.'); }
    if (value.format !== 1 || !value.versions || typeof value.versions !== 'object' ||
        Array.isArray(value.versions) || !Array.isArray(value.trash)) {
      throw new Error('Browser preview storage is not recognized. The original data has been preserved.');
    }
    value.books = validateLibrary(value).books;
    return value;
  }

  private write(value: PreviewEnvelope): void { this.storage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(value)); }

  async loadLibrary(): Promise<Library> { return { books: this.read().books }; }

  async saveBook(value: Book): Promise<Book> {
    const book = validateBook(value);
    const library = this.read();
    const index = library.books.findIndex(item => item.id === book.id);
    const current = library.books[index];
    if ((current?.revision ?? 0) !== book.revision) {
      throw { code: 'CONFLICT', message: 'This manuscript changed in another window. Retry to preserve your draft as a separate copy.' };
    }
    if (current) {
      const history = Object.hasOwn(library.versions, book.id) ? library.versions[book.id] : [];
      history.unshift({
        info: { id: crypto.randomUUID(), title: current.title, revision: current.revision, createdAt: current.updatedAt },
        book: cloneBook(current),
      });
      Object.defineProperty(library.versions, book.id, { value: history.slice(0, 30), enumerable: true, configurable: true, writable: true });
    }
    const saved = { ...book, revision: book.revision + 1, updatedAt: new Date().toISOString() };
    if (index >= 0) library.books[index] = saved;
    else library.books.unshift(saved);
    this.write(library);
    return cloneBook(saved);
  }

  async trashBook(id: string): Promise<void> {
    const library = this.read();
    const current = library.books.find(book => book.id === id);
    if (!current) throw new Error('The manuscript could not be found.');
    library.trash.unshift(current);
    library.books = library.books.filter(book => book.id !== id);
    this.write(library);
  }

  async listVersions(bookId: string): Promise<Version[]> {
    const library = this.read();
    return (Object.hasOwn(library.versions, bookId) ? library.versions[bookId] : []).map(version => ({ ...version.info }));
  }

  async readVersion(bookId: string, versionId: string): Promise<Book> {
    const library = this.read();
    const version = (Object.hasOwn(library.versions, bookId) ? library.versions[bookId] : []).find(item => item.info.id === versionId);
    if (!version) throw new Error('The recovery version could not be found.');
    return validateBook(version.book);
  }
}

export class DesktopStorageAdapter implements StorageAdapter {
  async loadLibrary(): Promise<Library> { return validateLibrary(await invoke('load_library')); }
  async saveBook(book: Book): Promise<Book> { return validateBook(await invoke('save_book', { book })); }
  async trashBook(id: string): Promise<void> { await invoke('trash_book', { id }); }
  async listVersions(bookId: string): Promise<Version[]> { return invoke('list_versions', { bookId }); }
  async readVersion(bookId: string, versionId: string): Promise<Book> {
    return validateBook(await invoke('read_version', { bookId, versionId }));
  }
}

export class DesktopDraftJournal implements DraftJournal {
  async read(): Promise<JournalEntry[]> {
    const value = await invoke<unknown>('read_draft_journal');
    return value === null ? [] : validateJournal(value);
  }

  async write(entries: JournalEntry[]): Promise<void> {
    await invoke('write_draft_journal', { journal: { format: 1, entries } });
  }
}

// Defer accessing localStorage so denied storage becomes a visible load/save error.
export const browserStorage: Storage = {
  get length() { return window.localStorage.length; },
  clear: () => window.localStorage.clear(),
  getItem: key => window.localStorage.getItem(key),
  key: index => window.localStorage.key(index),
  removeItem: key => window.localStorage.removeItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};

export function createStorageAdapter(): StorageAdapter {
  return isDesktop ? new DesktopStorageAdapter() : new BrowserStorageAdapter(browserStorage);
}
