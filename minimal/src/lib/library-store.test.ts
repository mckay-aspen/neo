import { afterEach, describe, expect, test } from 'bun:test';
import { copyEntries, type DraftJournal, type JournalEntry } from './journal';
import { LibraryStore } from './library-store';
import { newBook } from './manuscript';
import { cloneBook, type Book, type StorageAdapter } from './types';

class MemoryJournal implements DraftJournal {
  entries: JournalEntry[] = [];
  fail = false;
  read() { return copyEntries(this.entries); }
  write(entries: JournalEntry[]) {
    if (this.fail) throw new Error('Recovery storage is full');
    this.entries = copyEntries(entries);
  }
}

class MemoryAdapter implements StorageAdapter {
  books: Book[] = [];
  writes: Book[] = [];
  beforeSave: ((book: Book) => Promise<void>) | null = null;
  async loadLibrary() { return { books: this.books.map(cloneBook) }; }
  async saveBook(book: Book) {
    this.writes.push(cloneBook(book));
    await this.beforeSave?.(book);
    const index = this.books.findIndex(item => item.id === book.id);
    if ((this.books[index]?.revision ?? 0) !== book.revision) {
      throw { code: 'CONFLICT', message: 'Changed in another window' };
    }
    const saved = { ...cloneBook(book), revision: book.revision + 1 };
    if (index >= 0) this.books[index] = saved;
    else this.books.push(saved);
    return cloneBook(saved);
  }
  async trashBook(id: string) { this.books = this.books.filter(book => book.id !== id); }
  async listVersions() { return []; }
  async readVersion(): Promise<Book> { throw new Error('No version'); }
}

const stores: LibraryStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); });

function setup(adapter = new MemoryAdapter(), journal = new MemoryJournal()) {
  const store = new LibraryStore(adapter, journal, 60_000);
  stores.push(store);
  return { store, adapter, journal };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('acknowledged save queue', () => {
  test('slow journal writes coalesce typing into the newest snapshot and precede manuscript writes', async () => {
    const adapter = new MemoryAdapter();
    const release = deferred();
    const started = deferred();
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    let entries: JournalEntry[] = [];
    const writtenTitles: (string | undefined)[] = [];
    const journal: DraftJournal = {
      read: async () => entries,
      write: async next => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        calls++;
        if (calls === 2) { started.resolve(); await release.promise; }
        entries = copyEntries(next);
        writtenTitles.push(entries[0]?.book.title);
        active--;
      },
    };
    const store = new LibraryStore(adapter, journal, 60_000);
    stores.push(store);
    await store.initialize();
    const book = store.createBook('First title');
    await started.promise;
    for (let index = 0; index < 100; index++) store.updateBook({ ...book, title: `Edit ${index}` });
    const saving = store.flush();
    await Promise.resolve();
    expect(adapter.writes).toHaveLength(0);
    release.resolve();
    await saving;
    expect(maximumActive).toBe(1);
    expect(adapter.books[0].title).toBe('Edit 99');
    expect(entries).toEqual([]);
    expect(writtenTitles.filter(Boolean)).toEqual(['First title', 'Edit 99']);
  });

  test('a new library starts empty and does not seed example manuscripts', async () => {
    const { store, adapter } = setup();
    await store.initialize();
    expect(store.getSnapshot().books).toEqual([]);
    expect(store.getSnapshot().ready).toBe(true);
    expect(adapter.writes).toHaveLength(0);
  });

  test('edits made during a save survive and use the acknowledged revision', async () => {
    const { store, adapter, journal } = setup();
    await store.initialize();
    const started = deferred();
    const release = deferred();
    adapter.beforeSave = async () => { started.resolve(); await release.promise; };
    const book = store.createBook('A novel');
    const saving = store.flush();
    await started.promise;
    store.updateBook({ ...book, notes: 'written while the first save is in flight' });
    await Promise.resolve();
    await Promise.resolve();
    expect(journal.entries[0].saving?.notes).toBe('');
    expect(journal.entries[0].book.notes).toContain('in flight');
    release.resolve();
    await saving;
    expect(adapter.writes.map(item => item.revision)).toEqual([0, 1]);
    expect(store.getSnapshot().books[0].notes).toContain('in flight');
    expect(store.getSnapshot().books[0].revision).toBe(2);
    expect(adapter.books[0].notes).toContain('in flight');
    expect(journal.entries).toEqual([]);
    expect(store.getSnapshot().saveState).toBe('saved');
  });

  test('concurrent flushes share the same queue without duplicate writes', async () => {
    const { store, adapter } = setup();
    await store.initialize();
    store.createBook('One');
    store.createBook('Two');
    await Promise.all([store.flush(), store.flush(), store.flush()]);
    expect(adapter.writes).toHaveLength(2);
    expect(adapter.books.map(book => book.revision)).toEqual([1, 1]);
  });

  test('failed writes remain dirty and journaled until a successful retry', async () => {
    const { store, adapter, journal } = setup();
    await store.initialize();
    store.createBook('Never lose this');
    adapter.beforeSave = async () => { throw new Error('Disk is full'); };
    await expect(store.flush()).rejects.toThrow('Disk is full');
    expect(store.getSnapshot().saveState).toBe('error');
    expect(store.getSnapshot().unsavedCount).toBe(1);
    expect(journal.entries[0].book.title).toBe('Never lose this');
    adapter.beforeSave = null;
    await store.retry();
    expect(store.getSnapshot().saveState).toBe('saved');
    expect(store.getSnapshot().unsavedCount).toBe(0);
    expect(adapter.books[0].title).toBe('Never lose this');
    expect(journal.entries).toEqual([]);
  });

  test('journal failure is visible and does not authorize an unjournaled write', async () => {
    const { store, adapter, journal } = setup();
    await store.initialize();
    journal.fail = true;
    store.createBook('Still in memory');
    await expect(store.flush()).rejects.toThrow('full');
    expect(store.getSnapshot().error).toContain('full');
    expect(adapter.writes).toHaveLength(0);
    expect(store.getSnapshot().unsavedCount).toBe(1);
    journal.fail = false;
    await store.retry();
    expect(adapter.books[0].title).toBe('Still in memory');
  });

  test('a stale render or restored version cannot reset the current revision', async () => {
    const { store, adapter } = setup();
    await store.initialize();
    const stale = store.createBook('Book');
    await store.flush();
    store.updateBook({ ...stale, notes: 'Restored text' });
    await store.flush();
    expect(adapter.writes.map(book => book.revision)).toEqual([0, 1]);
    expect(adapter.books[0].notes).toBe('Restored text');
  });
});

describe('interrupted session recovery', () => {
  test('replays an unsaved new manuscript after restart', async () => {
    const { store, adapter, journal } = setup();
    journal.entries = [{ book: { ...newBook('Recovered'), notes: 'Unfinished thought' } }];
    await store.initialize();
    expect(store.getSnapshot().recoveryNotice).toContain('Recovered unsaved');
    expect(store.getSnapshot().books[0].notes).toBe('Unfinished thought');
    await store.flush();
    expect(adapter.books[0].title).toBe('Recovered');
  });

  test('recognizes a committed in-flight save and rebases later unsaved edits', async () => {
    const { store, adapter, journal } = setup();
    const outgoing = newBook('Book');
    outgoing.notes = 'First edit';
    adapter.books = [{ ...cloneBook(outgoing), revision: 1 }];
    journal.entries = [{ saving: outgoing, book: { ...cloneBook(outgoing), notes: 'Second edit' } }];
    await store.initialize();
    expect(store.getSnapshot().books).toHaveLength(1);
    expect(store.getSnapshot().books[0].revision).toBe(1);
    expect(store.getSnapshot().books[0].notes).toBe('Second edit');
    await store.flush();
    expect(adapter.books[0].revision).toBe(2);
    expect(adapter.books[0].notes).toBe('Second edit');
  });

  test('drops a journal already committed before a crash', async () => {
    const { store, adapter, journal } = setup();
    const book = newBook('Already saved');
    adapter.books = [{ ...cloneBook(book), revision: 1 }];
    journal.entries = [{ book }];
    await store.initialize();
    expect(store.getSnapshot().saveState).toBe('saved');
    expect(journal.entries).toEqual([]);
    expect(adapter.writes).toHaveLength(0);
  });

  test('conflicting recovery creates a copy and leaves the newer disk manuscript intact', async () => {
    const { store, adapter, journal } = setup();
    const book = newBook('Book');
    adapter.books = [{ ...cloneBook(book), revision: 3, notes: 'Other window' }];
    journal.entries = [{ book: { ...cloneBook(book), revision: 1, notes: 'My work' } }];
    await store.initialize();
    expect(store.getSnapshot().books).toHaveLength(2);
    expect(store.getSnapshot().recoveryNotice).toContain('separate copies');
    await store.flush();
    expect(adapter.books.find(item => item.id === book.id)?.notes).toBe('Other window');
    expect(adapter.books.find(item => item.id !== book.id)?.notes).toBe('My work');
  });

  test('retry resolves a live conflict by preserving both copies', async () => {
    const { store, adapter } = setup();
    const book = { ...newBook('Book'), revision: 1 };
    adapter.books = [cloneBook(book)];
    await store.initialize();
    store.updateBook({ ...book, notes: 'My current text' });
    adapter.books[0] = { ...adapter.books[0], revision: 2, notes: 'Concurrent text' };
    await expect(store.flush()).rejects.toMatchObject({ code: 'CONFLICT' });
    await store.retry();
    expect(adapter.books).toHaveLength(2);
    expect(adapter.books.map(item => item.notes).sort()).toEqual(['Concurrent text', 'My current text']);
    expect(store.getSnapshot().saveState).toBe('saved');
  });

  test('failed initialization preserves the journal and blocks accidental replacement', async () => {
    const { store, adapter, journal } = setup();
    journal.entries = [{ book: newBook('Keep me') }];
    adapter.loadLibrary = async () => { throw new Error('Unreadable library'); };
    await expect(store.initialize()).rejects.toThrow('Unreadable library');
    expect(store.getSnapshot().ready).toBe(false);
    expect(store.getSnapshot().loading).toBe(false);
    expect(journal.entries[0].book.title).toBe('Keep me');
    expect(() => store.createBook('Replacement')).toThrow('Open the library');
    expect(adapter.writes).toHaveLength(0);
  });
});
