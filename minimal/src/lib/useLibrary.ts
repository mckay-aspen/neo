import { useEffect, useState, useSyncExternalStore } from 'react';
import { LocalDraftJournal } from './journal';
import { LibraryStore } from './library-store';
import { browserStorage, createStorageAdapter, DesktopDraftJournal, isDesktop, JOURNAL_KEY } from './storage';

export function useLibrary() {
  const [store] = useState(() => new LibraryStore(
    createStorageAdapter(), isDesktop ? new DesktopDraftJournal() : new LocalDraftJournal(browserStorage, JOURNAL_KEY),
  ));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { void store.initialize().catch(() => {}); }, [store]);
  return {
    ...snapshot,
    updateBook: store.updateBook,
    createBook: store.createBook,
    flush: store.flush,
    retry: store.retry,
    trashBook: store.trashBook,
    listVersions: store.listVersions,
    readVersion: store.readVersion,
  };
}
