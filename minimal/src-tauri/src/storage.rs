use crate::review::{self, ReviewData};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_BOOK_BYTES: u64 = 40 * 1024 * 1024;
const MAX_CONTENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_VERSIONS: usize = 30;
const MAX_JOURNAL_BYTES: u64 = 128 * 1024 * 1024;
const CHECKPOINT_INTERVAL: Duration = Duration::minutes(5);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointClock {
    last_created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: String,
    pub goal: u32,
    pub updated_at: String,
    pub revision: u64,
    pub chapters: Vec<Chapter>,
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewData>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chapter {
    pub id: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub books: Vec<Book>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub created_at: String,
    pub title: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftJournal {
    pub format: u32,
    pub entries: Vec<JournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JournalEntry {
    pub book: Book,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saving: Option<Book>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StoreError {
    pub code: String,
    pub message: String,
}

impl StoreError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn io(context: &str, error: impl fmt::Display) -> Self {
        Self::new("IO", format!("{context}: {error}"))
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_INPUT", message)
    }

    fn corrupt(message: impl Into<String>) -> Self {
        Self::new("CORRUPT_DATA", message)
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl Error for StoreError {}

/// All commands share a mutex around this store. Books and their history live in
/// one directory, so moving a book to trash preserves everything in one rename.
pub struct LibraryStore {
    root: PathBuf,
    // Dropping the file releases the OS lock, including after a crash.
    _exclusive_lock: File,
}

impl LibraryStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let root = root.into();
        if root.as_os_str().is_empty() {
            return Err(StoreError::invalid(
                "The library directory cannot be empty.",
            ));
        }
        ensure_dir(&root)?;
        let lock_path = root.join("library.lock");
        reject_symlink(&lock_path)?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|e| StoreError::io("Could not open the library lock", e))?;
        lock.try_lock().map_err(|e| StoreError::new("LIBRARY_IN_USE", format!("Could not exclusively lock the library. Close any other NEO Minimal window using this library and try again: {e}")))?;
        ensure_dir(&root.join("books"))?;
        ensure_dir(&root.join("trash"))?;
        Ok(Self {
            root,
            _exclusive_lock: lock,
        })
    }

    pub fn load_library(&self) -> Result<Library, StoreError> {
        let mut books = Vec::new();
        for entry in fs::read_dir(self.root.join("books"))
            .map_err(|e| StoreError::io("Could not read the library", e))?
        {
            let entry = entry.map_err(|e| StoreError::io("Could not read a library entry", e))?;
            let kind = entry
                .file_type()
                .map_err(|e| StoreError::io("Could not inspect a library entry", e))?;
            if kind.is_symlink() {
                return Err(StoreError::corrupt(
                    "A book directory is a symbolic link; it was left untouched.",
                ));
            }
            if !kind.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            validate_id(&id)?;
            let path = entry.path().join("book.json");
            // A failed first save may leave a directory without a manuscript.
            if !path
                .try_exists()
                .map_err(|e| StoreError::io("Could not inspect a book", e))?
            {
                continue;
            }
            books.push(read_book(&path, &id)?);
        }
        books.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        Ok(Library { books })
    }

    pub fn read_draft_journal(&self) -> Result<Option<DraftJournal>, StoreError> {
        let path = self.root.join("draft-journal.json");
        if !path
            .try_exists()
            .map_err(|e| StoreError::io("Could not inspect the draft journal", e))?
        {
            return Ok(None);
        }
        require_regular_file(&path)?;
        let mut bytes = Vec::new();
        File::open(&path)
            .map_err(|e| StoreError::io("Could not open the draft journal", e))?
            .take(MAX_JOURNAL_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| StoreError::io("Could not read the draft journal", e))?;
        if bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err(StoreError::corrupt(
                "The draft journal exceeds 128 MB and was left untouched.",
            ));
        }
        let journal: DraftJournal = serde_json::from_slice(&bytes).map_err(|e| {
            StoreError::corrupt(format!(
                "The draft journal is unreadable and was left untouched: {e}"
            ))
        })?;
        validate_journal(&journal).map_err(|e| StoreError::corrupt(e.message))?;
        Ok(Some(journal))
    }

    pub fn write_draft_journal(&self, journal: DraftJournal) -> Result<(), StoreError> {
        validate_journal(&journal)?;
        // Never erase a corrupt journal; its text may still be manually recoverable.
        self.read_draft_journal()?;
        let bytes = serde_json::to_vec_pretty(&journal)
            .map_err(|e| StoreError::io("Could not encode the draft journal", e))?;
        if bytes.len() as u64 > MAX_JOURNAL_BYTES {
            return Err(StoreError::invalid(
                "The draft journal exceeds 128 MB. Export pending drafts before continuing.",
            ));
        }
        atomic_write(&self.root.join("draft-journal.json"), &bytes)
    }

    pub fn save_book(&self, book: Book) -> Result<Book, StoreError> {
        self.save_book_at(book, Utc::now())
    }

    fn save_book_at(&self, mut book: Book, now: DateTime<Utc>) -> Result<Book, StoreError> {
        validate_book(&book)?;
        let dir = self.book_dir(&book.id)?;
        let path = dir.join("book.json");
        let existing = if path
            .try_exists()
            .map_err(|e| StoreError::io("Could not inspect the current book", e))?
        {
            Some(read_book(&path, &book.id)?)
        } else {
            None
        };
        let current_revision = existing.as_ref().map_or(0, |b| b.revision);
        if book.revision != current_revision {
            return Err(StoreError::new("CONFLICT", "This book changed after it was opened. Your draft has not replaced the saved copy. Reopen the library before restoring your draft."));
        }
        if let Some(previous) = &existing {
            review::validate_append_only(previous.review.as_ref(), book.review.as_ref())?;
        }
        book.revision = current_revision
            .checked_add(1)
            .ok_or_else(|| StoreError::invalid("The revision counter is exhausted."))?;
        book.updated_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        let bytes = encode_book(&book)?;
        ensure_dir(&dir)?;
        if let Some(previous) = existing {
            let previous_bytes = encode_book(&previous)?;
            if checkpoint_due(&dir, now)? {
                let versions = dir.join("versions");
                ensure_dir(&versions)?;
                let version_path = versions.join(format!("{:020}.json", previous.revision));
                if version_path
                    .try_exists()
                    .map_err(|e| StoreError::io("Could not inspect a recovery version", e))?
                {
                    if read_book(&version_path, &previous.id)? != previous {
                        return Err(StoreError::corrupt("An existing recovery version differs from the saved book. No files were overwritten."));
                    }
                } else {
                    atomic_write(&version_path, &previous_bytes)?;
                }
                let clock = CheckpointClock {
                    last_created_at: now.to_rfc3339_opts(SecondsFormat::Millis, true),
                };
                let clock_bytes = serde_json::to_vec_pretty(&clock)
                    .map_err(|e| StoreError::io("Could not encode checkpoint timing", e))?;
                // Archival precedes the manuscript commit, so archival failures
                // never report a failed save after committing a new manuscript.
                self.archive_old_versions(&dir)?;
                atomic_write(&dir.join("checkpoint-clock.json"), &clock_bytes)?;
            }
            // Keep the immediately preceding successful save even between the
            // five-minute checkpoints. Replacing this rolling file is intentional.
            atomic_write(&dir.join("previous.json"), &previous_bytes)?;
        }
        atomic_write(&path, &bytes)?;
        Ok(book)
    }

    pub fn trash_book(&self, id: &str) -> Result<(), StoreError> {
        let dir = self.book_dir(id)?;
        if !dir
            .join("book.json")
            .try_exists()
            .map_err(|e| StoreError::io("Could not inspect the book", e))?
        {
            return Err(StoreError::new(
                "NOT_FOUND",
                "This book is no longer in the library.",
            ));
        }
        // Inspect without parsing: corrupt manuscripts must remain recoverable too.
        require_regular_file(&dir.join("book.json"))?;
        let trash = self.root.join("trash");
        let prefix = format!("{}-{}-", id, Utc::now().format("%Y%m%dT%H%M%S%.9fZ"));
        let reservation = tempfile::Builder::new()
            .prefix(&prefix)
            .tempdir_in(&trash)
            .map_err(|e| StoreError::io("Could not reserve a trash location", e))?;
        let destination = reservation.path().join("book");
        fs::rename(&dir, &destination)
            .map_err(|e| StoreError::io("Could not move the book to trash", e))?;
        // Keep the unique enclosing directory rather than allowing TempDir to remove it.
        let kept = reservation.keep();
        sync_dir(&kept)?;
        sync_dir(&trash)?;
        sync_dir(&self.root.join("books"))?;
        Ok(())
    }

    pub fn list_versions(&self, book_id: &str) -> Result<Vec<Version>, StoreError> {
        let dir = self.book_dir(book_id)?;
        let current = read_book(&dir.join("book.json"), book_id)?;
        let mut versions = Vec::new();
        for path in version_paths(&dir.join("versions"))? {
            let saved = read_book(&path, book_id)?;
            if saved.revision >= current.revision {
                continue;
            }
            versions.push(Version {
                id: path.file_stem().unwrap().to_string_lossy().into_owned(),
                created_at: saved.updated_at,
                title: saved.title,
                revision: saved.revision,
            });
        }
        let previous_path = dir.join("previous.json");
        if previous_path
            .try_exists()
            .map_err(|e| StoreError::io("Could not inspect the previous save", e))?
        {
            let previous = read_book(&previous_path, book_id)?;
            if previous.revision < current.revision
                && !versions.iter().any(|v| v.revision == previous.revision)
            {
                versions.push(Version {
                    id: format!("previous-{:020}", previous.revision),
                    created_at: previous.updated_at,
                    title: previous.title,
                    revision: previous.revision,
                });
            }
        }
        versions.sort_by_key(|a| std::cmp::Reverse(a.revision));
        versions.truncate(MAX_VERSIONS);
        Ok(versions)
    }

    pub fn read_version(&self, book_id: &str, version_id: &str) -> Result<Book, StoreError> {
        validate_id(version_id)?;
        let dir = self.book_dir(book_id)?;
        if let Some(revision) = version_id.strip_prefix("previous-") {
            let revision = revision
                .parse::<u64>()
                .map_err(|_| StoreError::invalid("The previous-save identifier is invalid."))?;
            let previous = read_book(&dir.join("previous.json"), book_id)?;
            if previous.revision != revision {
                return Err(StoreError::new("NOT_FOUND", "A newer save replaced this recent recovery version. Refresh the version list before choosing one."));
            }
            return Ok(previous);
        }
        for folder in ["versions", "archive"] {
            let history = dir.join(folder);
            reject_symlink(&history)?;
            let path = history.join(format!("{version_id}.json"));
            if path
                .try_exists()
                .map_err(|e| StoreError::io("Could not inspect the recovery version", e))?
            {
                return read_book(&path, book_id);
            }
        }
        Err(StoreError::new(
            "NOT_FOUND",
            "This recovery version could not be found.",
        ))
    }

    fn book_dir(&self, id: &str) -> Result<PathBuf, StoreError> {
        validate_id(id)?;
        let dir = self.root.join("books").join(id);
        reject_symlink(&self.root.join("books"))?;
        reject_symlink(&dir)?;
        Ok(dir)
    }

    fn archive_old_versions(&self, dir: &Path) -> Result<(), StoreError> {
        let history = dir.join("versions");
        let mut paths = version_paths(&history)?;
        paths.sort();
        let excess = paths.len().saturating_sub(MAX_VERSIONS);
        if excess == 0 {
            return Ok(());
        }
        let archive = dir.join("archive");
        ensure_dir(&archive)?;
        for path in paths.into_iter().take(excess) {
            let destination = archive.join(path.file_name().unwrap());
            if destination
                .try_exists()
                .map_err(|e| StoreError::io("Could not inspect archived history", e))?
            {
                return Err(StoreError::corrupt("A recovery archive already exists at the expected location. No version was overwritten."));
            }
            fs::rename(path, destination)
                .map_err(|e| StoreError::io("Could not archive a recovery version", e))?;
        }
        sync_dir(&archive)?;
        sync_dir(&history)
    }
}

fn checkpoint_due(dir: &Path, now: DateTime<Utc>) -> Result<bool, StoreError> {
    let path = dir.join("checkpoint-clock.json");
    if !path
        .try_exists()
        .map_err(|e| StoreError::io("Could not inspect checkpoint timing", e))?
    {
        return Ok(true);
    }
    require_regular_file(&path)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| StoreError::io("Could not open checkpoint timing", e))?
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|e| StoreError::io("Could not read checkpoint timing", e))?;
    if bytes.len() > 4096 {
        return Err(StoreError::corrupt(
            "Checkpoint timing is too large and was left untouched.",
        ));
    }
    let clock: CheckpointClock = serde_json::from_slice(&bytes).map_err(|e| {
        StoreError::corrupt(format!(
            "Checkpoint timing is unreadable and was left untouched: {e}"
        ))
    })?;
    let last = DateTime::parse_from_rfc3339(&clock.last_created_at).map_err(|e| {
        StoreError::corrupt(format!("Checkpoint timing has an invalid timestamp: {e}"))
    })?;
    // If the system clock moves backward, maintain the previous-save backup but
    // wait until the checkpoint interval catches up instead of creating a burst.
    Ok(now.signed_duration_since(last) >= CHECKPOINT_INTERVAL)
}

pub(crate) fn validate_id(id: &str) -> Result<(), StoreError> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(StoreError::invalid(
            "Identifiers must contain 1–80 letters, numbers, hyphens, or underscores.",
        ));
    }
    Ok(())
}

fn validate_book(book: &Book) -> Result<(), StoreError> {
    validate_id(&book.id)?;
    if book.title.trim().is_empty() || book.title.chars().count() > 240 {
        return Err(StoreError::invalid(
            "Book titles must contain 1–240 characters.",
        ));
    }
    if book.author.chars().count() > 240
        || book.description.len() > 100_000
        || book.notes.len() > 2_000_000
    {
        return Err(StoreError::invalid(
            "The author, description, or notes exceed the supported length.",
        ));
    }
    if book.goal > 10_000_000 || book.chapters.len() > 2_000 {
        return Err(StoreError::invalid(
            "A book supports up to 2,000 chapters and a 10,000,000-word goal.",
        ));
    }
    if book.updated_at.len() > 64 {
        return Err(StoreError::invalid("The update timestamp is too long."));
    }
    let mut ids = HashSet::new();
    let mut content_bytes = 0usize;
    for chapter in &book.chapters {
        validate_id(&chapter.id)?;
        if !ids.insert(&chapter.id) {
            return Err(StoreError::invalid(
                "Chapter identifiers must be unique within a book.",
            ));
        }
        if chapter.title.chars().count() > 240 || chapter.content.len() > MAX_CONTENT_BYTES {
            return Err(StoreError::invalid(
                "A chapter title or its text exceeds the supported length.",
            ));
        }
        content_bytes += chapter.content.len();
    }
    if content_bytes as u64 > MAX_BOOK_BYTES {
        return Err(StoreError::invalid("A book must be smaller than 40 MB."));
    }
    if let Some(review) = &book.review {
        review::validate(review)?;
    }
    Ok(())
}

fn validate_journal(journal: &DraftJournal) -> Result<(), StoreError> {
    if journal.format != 1 || journal.entries.len() > 100 {
        return Err(StoreError::invalid(
            "The draft journal has an unsupported format or exceeds 100 pending books.",
        ));
    }
    let mut ids = HashSet::new();
    for entry in &journal.entries {
        validate_book(&entry.book)?;
        if !ids.insert(&entry.book.id) {
            return Err(StoreError::invalid(
                "The draft journal contains duplicate books.",
            ));
        }
        if let Some(saving) = &entry.saving {
            validate_book(saving)?;
            if saving.id != entry.book.id {
                return Err(StoreError::invalid(
                    "A draft journal save must belong to its pending book.",
                ));
            }
        }
    }
    Ok(())
}

fn encode_book(book: &Book) -> Result<Vec<u8>, StoreError> {
    let mut bytes = serde_json::to_vec_pretty(book)
        .map_err(|e| StoreError::io("Could not encode the book", e))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_BOOK_BYTES {
        return Err(StoreError::invalid("A book must be smaller than 40 MB."));
    }
    Ok(bytes)
}

fn read_book(path: &Path, id: &str) -> Result<Book, StoreError> {
    require_regular_file(path)?;
    let file = File::open(path).map_err(|e| StoreError::io("Could not open a saved book", e))?;
    let mut bytes = Vec::new();
    file.take(MAX_BOOK_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| StoreError::io("Could not read a saved book", e))?;
    if bytes.len() as u64 > MAX_BOOK_BYTES {
        return Err(StoreError::corrupt(
            "A saved book exceeds the 40 MB limit and was left untouched.",
        ));
    }
    let book: Book = serde_json::from_slice(&bytes).map_err(|e| {
        StoreError::corrupt(format!(
            "Could not read {}. The file was left untouched: {e}",
            path.display()
        ))
    })?;
    validate_book(&book).map_err(|e| StoreError::corrupt(e.message))?;
    if book.id != id
        || book.revision == 0
        || chrono::DateTime::parse_from_rfc3339(&book.updated_at).is_err()
    {
        return Err(StoreError::corrupt("A saved book has an invalid identifier, revision, or timestamp and was left untouched."));
    }
    Ok(book)
}

fn reject_symlink(path: &Path) -> Result<(), StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(StoreError::corrupt(format!(
            "Refusing a symbolic link at {}.",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(StoreError::io("Could not inspect a library path", e)),
    }
}

fn require_regular_file(path: &Path) -> Result<(), StoreError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(()),
        Ok(_) => Err(StoreError::corrupt(
            "A saved book is not a regular file and was left untouched.",
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(StoreError::new(
            "NOT_FOUND",
            "The saved book could not be found.",
        )),
        Err(e) => Err(StoreError::io("Could not inspect a saved book", e)),
    }
}

fn ensure_dir(path: &Path) -> Result<(), StoreError> {
    reject_symlink(path)?;
    let existed = path
        .try_exists()
        .map_err(|e| StoreError::io("Could not inspect a library directory", e))?;
    fs::create_dir_all(path)
        .map_err(|e| StoreError::io("Could not create a library directory", e))?;
    if !existed {
        sync_dir(path)?;
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            sync_dir(parent)?;
        }
    }
    Ok(())
}

fn version_paths(dir: &Path) -> Result<Vec<PathBuf>, StoreError> {
    reject_symlink(dir)?;
    if !dir
        .try_exists()
        .map_err(|e| StoreError::io("Could not inspect recovery history", e))?
    {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in
        fs::read_dir(dir).map_err(|e| StoreError::io("Could not read recovery history", e))?
    {
        let entry = entry.map_err(|e| StoreError::io("Could not read a recovery entry", e))?;
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
            require_regular_file(&path)?;
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or_else(|| StoreError::corrupt("A recovery version has an invalid name."))?;
            validate_id(id)?;
            paths.push(path);
        }
    }
    Ok(paths)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .ok_or_else(|| StoreError::invalid("The save path has no parent directory."))?;
    reject_symlink(path)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|e| StoreError::io("Could not create a temporary save", e))?;
    temporary
        .write_all(bytes)
        .map_err(|e| StoreError::io("Could not write the temporary save", e))?;
    temporary
        .flush()
        .map_err(|e| StoreError::io("Could not flush the temporary save", e))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| StoreError::io("Could not sync the temporary save", e))?;
    temporary
        .persist(path)
        .map_err(|e| StoreError::io("Could not commit the saved book", e.error))?;
    sync_dir(parent)
}

#[cfg(feature = "desktop")]
pub(crate) fn export_text(path: &Path, content: &str) -> Result<(), StoreError> {
    atomic_write(path, content.as_bytes())
}

#[cfg(unix)]
fn sync_dir(path: &Path) -> Result<(), StoreError> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| StoreError::io("Could not sync a library directory", e))
}

// Windows does not permit opening directories as ordinary File handles. The
// file itself is flushed before its atomic rename on every platform.
#[cfg(not(unix))]
fn sync_dir(_path: &Path) -> Result<(), StoreError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft() -> Book {
        Book {
            id: "book-1".into(),
            title: "The Quiet Sea".into(),
            author: "A. Writer".into(),
            description: String::new(),
            goal: 80_000,
            updated_at: String::new(),
            revision: 0,
            chapters: vec![Chapter {
                id: "chapter-1".into(),
                title: "Arrival".into(),
                content: "The tide returned.\n\nSo did she. 🌊".into(),
            }],
            notes: "Remember the lighthouse.".into(),
            review: None,
        }
    }

    fn store() -> (tempfile::TempDir, LibraryStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = LibraryStore::open(directory.path()).unwrap();
        (directory, store)
    }

    fn time(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + seconds, 0).unwrap()
    }

    #[test]
    fn persistence_roundtrip_and_camel_case() {
        let (directory, store) = store();
        assert!(store.load_library().unwrap().books.is_empty());
        let saved = store.save_book(draft()).unwrap();
        assert_eq!(saved.revision, 1);
        assert!(chrono::DateTime::parse_from_rfc3339(&saved.updated_at).is_ok());
        drop(store);
        let reopened = LibraryStore::open(directory.path()).unwrap();
        assert_eq!(reopened.load_library().unwrap().books, vec![saved]);
        let json = fs::read_to_string(directory.path().join("books/book-1/book.json")).unwrap();
        assert!(json.contains("\"updatedAt\""));
        assert!(!json.contains("updated_at"));
    }

    #[test]
    fn a_second_process_cannot_open_the_same_library_for_writing() {
        let (directory, store) = store();
        let error = LibraryStore::open(directory.path())
            .err()
            .expect("second store should be locked out");
        assert_eq!(error.code, "LIBRARY_IN_USE");
        drop(store);
        assert!(LibraryStore::open(directory.path()).is_ok());
    }

    #[test]
    fn corrupt_data_is_never_silently_replaced() {
        let (directory, store) = store();
        let saved = store.save_book(draft()).unwrap();
        let path = directory.path().join("books/book-1/book.json");
        fs::write(&path, "{broken manuscript").unwrap();
        assert_eq!(store.load_library().unwrap_err().code, "CORRUPT_DATA");
        assert_eq!(store.save_book(saved).unwrap_err().code, "CORRUPT_DATA");
        assert_eq!(fs::read_to_string(path).unwrap(), "{broken manuscript");
    }

    #[test]
    fn unsafe_identifiers_are_rejected_at_every_boundary() {
        let (_directory, store) = store();
        for id in [
            "../outside",
            "/tmp/escape",
            "a/b",
            "a\\b",
            ".",
            "",
            "a.json",
        ] {
            let mut book = draft();
            book.id = id.into();
            assert_eq!(store.save_book(book).unwrap_err().code, "INVALID_INPUT");
            assert_eq!(store.trash_book(id).unwrap_err().code, "INVALID_INPUT");
            assert_eq!(store.list_versions(id).unwrap_err().code, "INVALID_INPUT");
            assert_eq!(
                store.read_version("book-1", id).unwrap_err().code,
                "INVALID_INPUT"
            );
        }
    }

    #[test]
    fn optimistic_conflicts_preserve_the_newer_manuscript() {
        let (_directory, store) = store();
        let saved = store.save_book(draft()).unwrap();
        let mut newer = saved.clone();
        newer.chapters[0].content = "A newer draft.".into();
        let newer = store.save_book(newer).unwrap();
        assert_eq!(store.save_book(saved).unwrap_err().code, "CONFLICT");
        assert_eq!(store.load_library().unwrap().books, vec![newer]);
    }

    #[test]
    fn history_can_be_read_and_restored_without_losing_current_work() {
        let (_directory, store) = store();
        let first = store.save_book(draft()).unwrap();
        let mut second = first.clone();
        second.chapters[0].content = "Second version.".into();
        let second = store.save_book(second).unwrap();
        let versions = store.list_versions(&first.id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].revision, 1);
        let mut restored = store.read_version(&first.id, &versions[0].id).unwrap();
        assert_eq!(restored, first);
        restored.revision = second.revision;
        let restored = store.save_book(restored).unwrap();
        assert_eq!(restored.revision, 3);
        assert_eq!(restored.chapters, first.chapters);
        let second_version = store
            .list_versions(&first.id)
            .unwrap()
            .into_iter()
            .find(|v| v.revision == 2)
            .unwrap();
        assert_eq!(
            store.read_version(&first.id, &second_version.id).unwrap(),
            second
        );
    }

    #[test]
    fn trash_preserves_manuscript_and_history_for_manual_recovery() {
        let (directory, store) = store();
        let first = store.save_book(draft()).unwrap();
        let second = store.save_book(first.clone()).unwrap();
        store.trash_book(&first.id).unwrap();
        assert!(store.load_library().unwrap().books.is_empty());
        let trashed = fs::read_dir(directory.path().join("trash"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join("book");
        assert_eq!(
            read_book(&trashed.join("book.json"), &first.id).unwrap(),
            second
        );
        assert_eq!(
            read_book(
                &trashed.join("versions/00000000000000000001.json"),
                &first.id
            )
            .unwrap(),
            first
        );
        fs::rename(&trashed, directory.path().join("books/book-1")).unwrap();
        assert_eq!(store.load_library().unwrap().books, vec![second]);
    }

    #[test]
    fn old_history_is_bounded_in_the_ui_and_archived_without_deletion() {
        let (directory, store) = store();
        let first = store.save_book_at(draft(), time(0)).unwrap();
        let mut saved = first.clone();
        for index in 1..=35 {
            saved = store.save_book_at(saved, time(index * 301)).unwrap();
        }
        assert_eq!(store.list_versions(&saved.id).unwrap().len(), MAX_VERSIONS);
        let archive = directory.path().join("books/book-1/archive");
        assert_eq!(fs::read_dir(archive).unwrap().count(), 5);
        assert_eq!(
            store
                .read_version(&saved.id, "00000000000000000001")
                .unwrap(),
            first
        );
    }

    #[test]
    fn quick_autosaves_keep_one_checkpoint_and_the_immediate_previous_save() {
        let (directory, store) = store();
        let first = store.save_book_at(draft(), time(0)).unwrap();
        let mut saved = first.clone();
        let mut previous = first.clone();
        for index in 1..=100 {
            previous = saved.clone();
            saved.chapters[0].content = format!("Draft number {index}");
            saved = store.save_book_at(saved, time(index)).unwrap();
        }
        let checkpoints = version_paths(&directory.path().join("books/book-1/versions")).unwrap();
        assert_eq!(checkpoints.len(), 1);
        assert!(!directory.path().join("books/book-1/archive").exists());
        let versions = store.list_versions(&saved.id).unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            store.read_version(&saved.id, &versions[0].id).unwrap(),
            previous
        );
        assert_eq!(
            store.read_version(&saved.id, &versions[1].id).unwrap(),
            first
        );
        let stale_id = versions[0].id.clone();
        store.save_book_at(saved, time(101)).unwrap();
        assert_eq!(
            store.read_version(&first.id, &stale_id).unwrap_err().code,
            "NOT_FOUND"
        );
    }

    #[test]
    fn checkpoint_cadence_uses_creation_time_and_handles_clock_changes() {
        let (directory, store) = store();
        let first = store.save_book_at(draft(), time(0)).unwrap();
        // The first replacement can occur long after the original book was saved.
        let second = store.save_book_at(first, time(1000)).unwrap();
        let third = store.save_book_at(second, time(1299)).unwrap();
        let versions = directory.path().join("books/book-1/versions");
        assert_eq!(version_paths(&versions).unwrap().len(), 1);
        let fourth = store.save_book_at(third.clone(), time(1300)).unwrap();
        assert_eq!(version_paths(&versions).unwrap().len(), 2);
        assert_eq!(
            store
                .read_version(&third.id, "00000000000000000003")
                .unwrap(),
            third
        );
        let fifth = store.save_book_at(fourth, time(1200)).unwrap();
        let sixth = store.save_book_at(fifth.clone(), time(1599)).unwrap();
        assert_eq!(version_paths(&versions).unwrap().len(), 2);
        let versions_list = store.list_versions(&sixth.id).unwrap();
        assert_eq!(
            store.read_version(&sixth.id, &versions_list[0].id).unwrap(),
            fifth
        );
        store.save_book_at(sixth, time(1600)).unwrap();
        assert_eq!(version_paths(&versions).unwrap().len(), 3);
    }

    #[test]
    fn duplicate_chapters_and_oversize_inputs_are_rejected() {
        let (_directory, store) = store();
        let mut book = draft();
        book.chapters.push(book.chapters[0].clone());
        assert_eq!(store.save_book(book).unwrap_err().code, "INVALID_INPUT");
        let mut book = draft();
        book.chapters[0].content = "x".repeat(MAX_CONTENT_BYTES + 1);
        assert_eq!(store.save_book(book).unwrap_err().code, "INVALID_INPUT");
    }

    #[test]
    fn journal_survives_restart_and_preserves_uncommitted_and_inflight_drafts() {
        let (directory, store) = store();
        assert_eq!(store.read_draft_journal().unwrap(), None);
        let mut newest = draft();
        newest.chapters[0].content = "Latest unsaved typing".into();
        let journal = DraftJournal {
            format: 1,
            entries: vec![JournalEntry {
                book: newest,
                saving: Some(draft()),
            }],
        };
        store.write_draft_journal(journal.clone()).unwrap();
        drop(store);
        let reopened = LibraryStore::open(directory.path()).unwrap();
        assert_eq!(reopened.read_draft_journal().unwrap(), Some(journal));
        reopened
            .write_draft_journal(DraftJournal {
                format: 1,
                entries: vec![],
            })
            .unwrap();
        assert!(reopened
            .read_draft_journal()
            .unwrap()
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn corrupt_journal_is_retained_when_a_write_is_attempted() {
        let (directory, store) = store();
        let path = directory.path().join("draft-journal.json");
        fs::write(&path, "interrupted draft text").unwrap();
        assert_eq!(store.read_draft_journal().unwrap_err().code, "CORRUPT_DATA");
        assert_eq!(
            store
                .write_draft_journal(DraftJournal {
                    format: 1,
                    entries: vec![]
                })
                .unwrap_err()
                .code,
            "CORRUPT_DATA"
        );
        assert_eq!(fs::read_to_string(path).unwrap(), "interrupted draft text");
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_cannot_redirect_manuscripts_outside_the_library() {
        let (directory, store) = store();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("books/book-1")).unwrap();
        assert_eq!(store.save_book(draft()).unwrap_err().code, "CORRUPT_DATA");
        assert_eq!(store.load_library().unwrap_err().code, "CORRUPT_DATA");
        assert!(!outside.path().join("book.json").exists());
    }

    #[test]
    fn legacy_books_gain_review_history_without_changing_manuscript_text() {
        let (directory, store) = store();
        let legacy = store.save_book(draft()).unwrap();
        let path = directory.path().join("books/book-1/book.json");
        assert!(!fs::read_to_string(&path).unwrap().contains("\"review\""));
        let mut reviewed = legacy.clone();
        reviewed.review = Some(crate::review::tests::review());
        let saved = store.save_book(reviewed).unwrap();
        assert_eq!(saved.chapters, legacy.chapters);
        assert_eq!(saved.notes, legacy.notes);
        drop(store);
        let reopened = LibraryStore::open(directory.path()).unwrap();
        assert_eq!(reopened.load_library().unwrap().books, vec![saved]);
    }

    #[test]
    fn saved_review_audit_cannot_be_omitted_truncated_or_rewritten() {
        let (directory, store) = store();
        let mut book = draft();
        book.review = Some(crate::review::tests::review());
        let saved = store.save_book(book).unwrap();
        let path = directory.path().join("books/book-1/book.json");
        let before = fs::read(&path).unwrap();
        let mut omitted = saved.clone();
        omitted.review = None;
        let mut truncated = saved.clone();
        truncated.review.as_mut().unwrap().events.clear();
        let mut rewritten = saved.clone();
        rewritten.review.as_mut().unwrap().events[0]["actor"] = serde_json::json!("Someone else");
        for invalid in [omitted, truncated, rewritten] {
            assert_eq!(store.save_book(invalid).unwrap_err().code, "INVALID_INPUT");
            assert_eq!(fs::read(&path).unwrap(), before);
        }
        let mut appended = saved.clone();
        appended.review.as_mut().unwrap().events.push(serde_json::json!({"id":"event-2","threadId":"thread-1","at":"2026-09-30T19:00:00Z","actor":"Editor","type":"thread_resolved"}));
        let appended = store.save_book(appended).unwrap();
        assert_eq!(appended.review.as_ref().unwrap().events.len(), 2);
        assert_eq!(appended.chapters, saved.chapters);
    }

    #[test]
    fn history_and_draft_journals_retain_reviews_and_restore_copies_keep_anchor_ids() {
        let (directory, store) = store();
        let mut first = draft();
        first.review = Some(crate::review::tests::review());
        let first = store.save_book(first).unwrap();
        let mut second = first.clone();
        second.chapters[0].content.push_str(" A revision.");
        second.review.as_mut().unwrap().events.push(serde_json::json!({"id":"event-2","threadId":"thread-1","at":"2026-09-30T19:00:00Z","actor":"Writer","type":"reply_added","messageId":"message-2","body":crate::review::tests::body("I updated the passage.")}));
        let second = store.save_book(second).unwrap();
        let snapshot = store
            .read_version(&first.id, "00000000000000000001")
            .unwrap();
        assert_eq!(snapshot.review, first.review);
        let pending = DraftJournal {
            format: 1,
            entries: vec![JournalEntry {
                book: second.clone(),
                saving: Some(second.clone()),
            }],
        };
        store.write_draft_journal(pending.clone()).unwrap();
        drop(store);
        let store = LibraryStore::open(directory.path()).unwrap();
        assert_eq!(store.read_draft_journal().unwrap(), Some(pending));
        let mut stale = snapshot.clone();
        stale.revision = second.revision;
        assert_eq!(store.save_book(stale).unwrap_err().code, "INVALID_INPUT");
        let mut restored = snapshot;
        restored.id = "restored-book".into();
        restored.revision = 0;
        let restored = store.save_book(restored).unwrap();
        assert_eq!(restored.chapters, first.chapters);
        assert_eq!(restored.review, first.review);
        assert_eq!(
            store
                .load_library()
                .unwrap()
                .books
                .into_iter()
                .find(|b| b.id == first.id)
                .unwrap(),
            second
        );
    }
}
