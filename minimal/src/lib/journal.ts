import { cloneBook, validateBook, type Book } from './types';

export interface JournalEntry {
  book: Book;
  /** The exact write that may have committed before the app was interrupted. */
  saving?: Book;
}

export interface DraftJournal {
  read(): JournalEntry[] | Promise<JournalEntry[]>;
  write(entries: JournalEntry[]): void | Promise<void>;
}

export function validateJournal(value: unknown): JournalEntry[] {
  if (!value || typeof value !== 'object' || (value as { format?: number }).format !== 1 ||
      !Array.isArray((value as { entries?: unknown }).entries)) {
    throw new Error('The draft recovery journal cannot be read. It has been preserved.');
  }
  const entries = (value as { entries: JournalEntry[] }).entries.map(entry => ({
    book: validateBook(entry.book),
    ...(entry.saving ? { saving: validateBook(entry.saving) } : {}),
  }));
  if (new Set(entries.map(entry => entry.book.id)).size !== entries.length) {
    throw new Error('The draft recovery journal contains duplicate manuscripts.');
  }
  return entries;
}

export class LocalDraftJournal implements DraftJournal {
  constructor(private storage: Storage, private key: string) {}

  read(): JournalEntry[] {
    const raw = this.storage.getItem(this.key);
    if (!raw) return [];
    let value: unknown;
    try { value = JSON.parse(raw); }
    catch { throw new Error('The draft recovery journal is damaged. It has been preserved.'); }
    return validateJournal(value);
  }

  write(entries: JournalEntry[]): void {
    if (!entries.length) this.storage.removeItem(this.key);
    else this.storage.setItem(this.key, JSON.stringify({ format: 1, entries }));
  }
}

export function copyEntries(entries: JournalEntry[]): JournalEntry[] {
  return entries.map(entry => ({ book: cloneBook(entry.book), ...(entry.saving ? { saving: cloneBook(entry.saving) } : {}) }));
}
