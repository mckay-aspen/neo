import { newBook } from './manuscript';
import { assertReviewAppendOnly, reviewFingerprint } from './review';
import type { DraftJournal, JournalEntry } from './journal';
import { cloneBook, errorMessage, validateBook, validateLibrary, type Book, type SaveState, type StorageAdapter } from './types';

export interface LibrarySnapshot {
  books: Book[];
  loading: boolean;
  ready: boolean;
  error: string | null;
  saveState: SaveState;
  recoveryNotice: string | null;
  unsavedCount: number;
}

function sameContent(left: Book, right: Book): boolean {
  const content = (book: Book) => JSON.stringify({
    id: book.id, title: book.title, author: book.author, description: book.description,
    goal: book.goal, chapters: book.chapters, notes: book.notes, review: reviewFingerprint(book.review),
  });
  return content(left) === content(right);
}

interface JournalBatch {
  entries: JournalEntry[];
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Owns acknowledged saves independently of React, including edits made during a write. */
export class LibraryStore {
  private books: Book[] = [];
  private dirty = new Set<string>();
  private generations = new Map<string, number>();
  private pending = new Map<string, Book>();
  private deleting = new Set<string>();
  private listeners = new Set<() => void>();
  private initialization: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  private journalRunning = false;
  private journalPending: JournalBatch | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ready = false;
  private loading = true;
  private failure: unknown = null;
  private recoveryNotice: string | null = null;
  private recoveryDrafts: JournalEntry[] | null = null;
  private snapshot: LibrarySnapshot = {
    books: [], loading: true, ready: false, error: null,
    saveState: 'saved', recoveryNotice: null, unsavedCount: 0,
  };

  constructor(private adapter: StorageAdapter, private journal: DraftJournal, private debounceMs = 600) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): LibrarySnapshot => this.snapshot;

  private emit(): void {
    this.snapshot = {
      books: this.books.map(cloneBook), loading: this.loading, ready: this.ready,
      error: this.failure ? errorMessage(this.failure) : null,
      saveState: this.failure ? 'error' : this.dirty.size ? 'saving' : 'saved',
      recoveryNotice: this.recoveryNotice, unsavedCount: this.dirty.size,
    };
    for (const listener of this.listeners) listener();
  }

  private entries(): JournalEntry[] {
    return this.books.filter(book => this.dirty.has(book.id)).map(book => ({
      book: cloneBook(book),
      ...(this.pending.has(book.id) ? { saving: cloneBook(this.pending.get(book.id)!) } : {}),
    }));
  }

  private writeJournal(): Promise<void> {
    // Keep at most an active write plus the newest pending snapshot. Everyone
    // waiting on a coalesced batch is acknowledged only after that batch commits.
    const entries = this.entries();
    if (this.journalPending) {
      this.journalPending.entries = entries;
      return this.journalPending.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.journalPending = { entries, promise, resolve, reject };
    if (!this.journalRunning) {
      this.journalRunning = true;
      void this.drainJournal();
    }
    return promise;
  }

  private async drainJournal(): Promise<void> {
    while (this.journalPending) {
      const batch = this.journalPending;
      this.journalPending = null;
      try { await this.journal.write(batch.entries); batch.resolve(); }
      catch (error) { batch.reject(error); }
    }
    this.journalRunning = false;
  }

  initialize = (): Promise<void> => {
    if (this.ready) return Promise.resolve();
    if (this.initialization) return this.initialization;
    this.loading = true;
    this.failure = null;
    this.emit();
    const task = this.load();
    this.initialization = task;
    void task.finally(() => { if (this.initialization === task) this.initialization = null; }).catch(() => {});
    return task;
  };

  private async load(): Promise<void> {
    try {
      const library = validateLibrary(await this.adapter.loadLibrary());
      const entries = this.recoveryDrafts ?? await this.journal.read();
      this.books = library.books;
      this.dirty.clear();
      this.pending.clear();
      let recovered = 0;
      let conflicts = 0;
      for (const entry of entries) {
        const working = cloneBook(entry.book);
        const index = this.books.findIndex(book => book.id === working.id);
        const disk = this.books[index];
        if (disk && sameContent(disk, working)) continue;
        const acknowledged = disk && entry.saving &&
          disk.revision === entry.saving.revision + 1 && sameContent(disk, entry.saving);
        let retainsHistory = true;
        if (disk) {
          try { assertReviewAppendOnly(disk.review, working.review); }
          catch { retainsHistory = false; }
        }
        if (retainsHistory && ((disk && disk.revision === working.revision) || acknowledged)) {
          working.revision = disk.revision;
          this.books[index] = working;
        } else if (!disk && working.revision === 0) {
          this.books.unshift(working);
        } else {
          // Never replace a newer or deleted manuscript with a stale recovery draft.
          working.id = crypto.randomUUID();
          working.title = `${Array.from(working.title).slice(0, 220).join('')} (recovered copy)`;
          working.revision = 0;
          this.books.unshift(working);
          conflicts++;
        }
        this.dirty.add(working.id);
        this.generations.set(working.id, 1);
        recovered++;
      }
      // Keep the original journal until the entire reconciliation has succeeded.
      await this.writeJournal();
      this.recoveryDrafts = null;
      this.recoveryNotice = recovered
        ? `Recovered unsaved changes in ${recovered} ${recovered === 1 ? 'manuscript' : 'manuscripts'}.${conflicts ? ' Conflicting drafts were kept as separate copies.' : ''}`
        : null;
      this.ready = true;
      this.failure = null;
    } catch (error) {
      this.failure = error;
      throw error;
    } finally {
      this.loading = false;
      this.emit();
    }
    if (this.dirty.size) this.schedule();
  }

  private requireReady(): void {
    if (!this.ready) throw new Error('Open the library successfully before making changes. Use Retry to try again.');
  }

  updateBook = (value: Book): void => {
    this.requireReady();
    const book = validateBook(value);
    if (this.deleting.has(book.id)) throw new Error('This manuscript is being moved to trash.');
    const index = this.books.findIndex(item => item.id === book.id);
    if (index >= 0) assertReviewAppendOnly(this.books[index].review, book.review);
    // Callers may hold a React render from before the latest save acknowledgment.
    book.revision = index >= 0 ? this.books[index].revision : 0;
    book.updatedAt = new Date().toISOString();
    if (index < 0) this.books.unshift(book);
    else this.books[index] = book;
    this.generations.set(book.id, (this.generations.get(book.id) ?? 0) + 1);
    this.dirty.add(book.id);
    void this.writeJournal().catch(error => { this.failure = error; this.emit(); });
    this.emit();
    this.schedule();
  };

  createBook = (title: string, author = ''): Book => {
    const book = newBook(title, author);
    this.updateBook(book);
    return cloneBook(book);
  };

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      // The rejection is represented in the observable state, never marked clean.
      void this.flush().catch(() => {});
    }, this.debounceMs);
  }

  flush = async (): Promise<void> => {
    this.cancelTimer();
    await this.initialize();
    if (this.running) return this.running;
    if (!this.dirty.size) {
      // A failed non-save action remains visible until an explicit retry.
      return;
    }
    const task = this.drain();
    this.running = task;
    try { await task; }
    finally { if (this.running === task) this.running = null; }
  };

  private async drain(): Promise<void> {
    this.failure = null;
    this.emit();
    try {
      while (this.dirty.size) {
        const id = this.dirty.values().next().value as string;
        const working = this.books.find(book => book.id === id);
        if (!working) throw new Error('An unsaved manuscript is missing from the library.');
        const generation = this.generations.get(id);
        const outgoing = cloneBook(working);
        this.pending.set(id, outgoing);
        await this.writeJournal();
        const saved = validateBook(await this.adapter.saveBook(outgoing));
        assertReviewAppendOnly(outgoing.review, saved.review);
        if (saved.id !== id || saved.revision !== outgoing.revision + 1) {
          throw new Error('The save was not acknowledged correctly. Your recovery draft is preserved.');
        }
        const index = this.books.findIndex(book => book.id === id);
        if (generation === this.generations.get(id)) {
          this.books[index] = saved;
          this.dirty.delete(id);
        } else {
          // Only the revision travels forward; newer text must never be replaced.
          this.books[index] = { ...this.books[index], revision: saved.revision };
        }
        this.pending.delete(id);
        try { await this.writeJournal(); }
        catch (error) {
          // Preserve a retry path even if the disk write succeeded but cleanup failed.
          this.dirty.add(id);
          throw error;
        }
        this.emit();
      }
      this.failure = null;
      this.emit();
    } catch (error) {
      this.cancelTimer();
      this.failure = error;
      this.emit();
      throw error;
    }
  }

  retry = async (): Promise<void> => {
    if (this.failure && typeof this.failure === 'object' &&
        'code' in this.failure && this.failure.code === 'CONFLICT') {
      // Reload through reconciliation so both the disk copy and local work survive.
      this.recoveryDrafts = this.entries();
      this.ready = false;
      await this.initialize();
    } else if (!this.ready) {
      await this.initialize();
    }
    await this.flush();
    this.failure = null;
    this.emit();
  };

  trashBook = async (id: string): Promise<void> => {
    this.requireReady();
    if (this.deleting.has(id)) return;
    this.deleting.add(id);
    try {
      await this.flush();
      await this.adapter.trashBook(id);
      this.books = this.books.filter(book => book.id !== id);
      this.generations.delete(id);
      this.failure = null;
      this.emit();
    } catch (error) {
      this.failure = error;
      this.emit();
      throw error;
    } finally { this.deleting.delete(id); }
  };

  listVersions = (bookId: string) => this.adapter.listVersions(bookId);
  readVersion = (bookId: string, versionId: string) => this.adapter.readVersion(bookId, versionId);

  /** Primarily useful for headless tests; the desktop close handler should await flush. */
  dispose(): void { this.cancelTimer(); this.listeners.clear(); }
}
