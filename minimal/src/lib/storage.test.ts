import { describe, expect, test } from 'bun:test';
import { LocalDraftJournal } from './journal';
import { newBook } from './manuscript';
import { BrowserStorageAdapter, PREVIEW_STORAGE_KEY } from './storage';

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: key => items.get(key) ?? null,
    key: index => [...items.keys()][index] ?? null,
    removeItem: key => { items.delete(key); },
    setItem: (key, value) => { items.set(key, value); },
  };
}

describe('browser preview storage', () => {
  test('persists revisions and retrieves the previous manuscript without changing it', async () => {
    const adapter = new BrowserStorageAdapter(memoryStorage());
    const first = await adapter.saveBook(newBook('First draft'));
    const second = await adapter.saveBook({ ...first, title: 'Second draft' });
    expect(second.revision).toBe(2);
    const [version] = await adapter.listVersions(first.id);
    expect((await adapter.readVersion(first.id, version.id)).title).toBe('First draft');
    expect((await adapter.loadLibrary()).books[0].title).toBe('Second draft');
    await expect(adapter.saveBook(first)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('corrupt library data is surfaced and left untouched', async () => {
    const storage = memoryStorage();
    storage.setItem(PREVIEW_STORAGE_KEY, '{not valid json');
    const adapter = new BrowserStorageAdapter(storage);
    await expect(adapter.loadLibrary()).rejects.toThrow('preserved');
    await expect(adapter.saveBook(newBook('Replacement'))).rejects.toThrow('preserved');
    expect(storage.getItem(PREVIEW_STORAGE_KEY)).toBe('{not valid json');
  });

  test('damaged draft recovery data is not mistaken for an empty journal', () => {
    const storage = memoryStorage();
    storage.setItem('journal', '{bad journal');
    const journal = new LocalDraftJournal(storage, 'journal');
    expect(() => journal.read()).toThrow('preserved');
    expect(storage.getItem('journal')).toBe('{bad journal');
  });

  test('trash removes a book from the library while preserving its stored content', async () => {
    const storage = memoryStorage();
    const adapter = new BrowserStorageAdapter(storage);
    const book = await adapter.saveBook(newBook('Recoverable'));
    await adapter.trashBook(book.id);
    expect((await adapter.loadLibrary()).books).toEqual([]);
    expect(JSON.parse(storage.getItem(PREVIEW_STORAGE_KEY)!).trash[0].title).toBe('Recoverable');
  });
});
