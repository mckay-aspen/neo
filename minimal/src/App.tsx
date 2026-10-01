import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FileText,
  Focus,
  History,
  Library,
  LoaderCircle,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  Upload,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { TypewriterQuote } from "@/components/typewriter-quote";
import { invoke } from "@tauri-apps/api/core";
import {
  useLibrary,
  isDesktop,
  words,
  totalWords,
  exportMarkdown,
  importMarkdown,
  errorMessage,
  type Book,
  type Version,
} from "./lib";

type ModalKind = "new" | "details" | "history" | "help" | null;
const number = (n: number) => n.toLocaleString();
const date = (s: string) =>
  new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function IconButton({
  children,
  title,
  ...props
}: ComponentProps<typeof Button>) {
  const label = title || props["aria-label"];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  );
}

function Modal({
  restoreFocusTo,
  title,
  onClose,
  children,
}: {
  title: string;
  restoreFocusTo: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const [opener] = useState(() => restoreFocusTo ?? document.activeElement as HTMLElement | null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="dialog"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          requestAnimationFrame(() => {
            const target =
              opener?.isConnected && opener !== document.body && !opener.closest("[inert]")
                ? opener
                : (document.querySelector<HTMLElement>(".prose-editor") ??
                  document.querySelector<HTMLElement>(".brand"));
            target?.focus();
          });
        }}
      >
        <div className="dialog-header">
          <DialogTitle>{title}</DialogTitle>
          <IconButton
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={18} />
          </IconButton>
        </div>
        <DialogDescription className="sr-only">
          {title}. Your manuscript is saved automatically.
        </DialogDescription>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function BookForm({
  book,
  onSave,
  onClose,
}: {
  book?: Book;
  onSave: (
    title: string,
    author: string,
    goal: number,
    description: string,
  ) => void;
  onClose: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        if (!String(data.get("title")).trim()) return;
        onSave(
          String(data.get("title")).trim(),
          String(data.get("author")).trim(),
          Number(data.get("goal")),
          String(data.get("description")),
        );
      }}
    >
      <Label>
        Title
        <Input
          autoFocus
          name="title"
          defaultValue={book?.title}
          placeholder="An idea worth following"
          required
          maxLength={200}
        />
      </Label>
      <Label>
        Author <span className="optional">optional</span>
        <Input
          name="author"
          defaultValue={book?.author}
          placeholder="Your name"
          maxLength={200}
        />
      </Label>
      <Label>
        Word goal
        <Input
          name="goal"
          type="number"
          defaultValue={book?.goal ?? 50000}
          min="0"
          max="10000000"
          step="1"
          required
        />
        <small>Set to 0 to write without a target.</small>
      </Label>
      {book && (
        <Label>
          A note about this book
          <Textarea
            name="description"
            defaultValue={book.description}
            placeholder="A small reminder of what this story could be."
            rows={3}
            maxLength={2000}
          />
        </Label>
      )}
      <div className="dialog-actions">
        <Button
          variant="outline"
          type="button"
          className="secondary"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button className="primary" type="submit">
          {book ? "Save details" : "Begin writing"}
          <ArrowRight size={16} />
        </Button>
      </div>
    </form>
  );
}

export default function App() {
  const library = useLibrary();
  const {
    books,
    loading,
    ready,
    error,
    saveState,
    updateBook,
    createBook,
    flush,
    retry,
    recoveryNotice,
  } = library;
  const [bookId, setBookId] = useState<string | null>(null);
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const modalOpener = useRef<HTMLElement | null>(null);
  const openModal = (kind: ModalKind, trigger?: HTMLElement) => { modalOpener.current = trigger ?? document.activeElement as HTMLElement | null; setModal(kind); };
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const entrance = {
    initial: { opacity: 0, y: reduceMotion ? 0 : 6 },
    animate: { opacity: 1, y: 0 },
  };
  const [focus, setFocus] = useState(false);
  const [notes, setNotes] = useState(false);
  const [notice, setNotice] = useState("");
  const [closing, setClosing] = useState(false);
  const historyRequest = useRef(0);
  const [versions, setVersions] = useState<Version[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [snapshot, setSnapshot] = useState<Book | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const flushRef = useRef(flush);
  const canCloseWithoutFlush = useRef(false);
  const book = books.find((b) => b.id === bookId);
  const chapter =
    book?.chapters.find((c) => c.id === chapterId) ?? book?.chapters[0];
  const total = book ? totalWords(book) : 0;
  const percent = book?.goal ? Math.min(100, (total / book.goal) * 100) : 0;
  flushRef.current = flush;
  canCloseWithoutFlush.current = !ready && library.unsavedCount === 0;

  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    let exitUnlisten: (() => void) | undefined;
    let disposed = false;
    const finish = async (action: () => Promise<unknown>) => {
      setClosing(true);
      setModal(null);
      setSortOpen(false);
      try {
        if (!canCloseWithoutFlush.current) await flushRef.current();
        await action();
      } catch {
        setClosing(false);
        setNotice(
          "Your window is staying open because the latest changes could not be saved. Retry saving or export a copy.",
        );
      }
    };
    import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        const stop = await win.onCloseRequested(async (event) => {
          event.preventDefault();
          await finish(() => win.destroy());
        });
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() =>
        setNotice(
          "Close protection could not start. Save or export your work before closing.",
        ),
      );
    import("@tauri-apps/api/event")
      .then(async ({ listen }) => {
        const stop = await listen("neo-request-exit", () => {
          void finish(() => invoke("finish_exit"));
        });
        if (disposed) stop();
        else exitUnlisten = stop;
      })
      .catch(() =>
        setNotice(
          "Quit protection could not start. Save or export your work before quitting.",
        ),
      );
    return () => {
      disposed = true;
      unlisten?.();
      exitUnlisten?.();
    };
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if ((event.metaKey || event.ctrlKey) && event.key === "s") {
        event.preventDefault();
        flushRef.current().catch(() => {});
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "f" &&
        bookId
      ) {
        event.preventDefault();
        setFocus((v) => !v);
      }
      if (event.key === "Escape" && !modal) {
        setFocus(false);
        setNotes(false);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        openModal("help");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [bookId, modal]);
  useEffect(() => {
    const element = editor.current;
    if (!element) return;
    const resize = () => {
      element.style.height = "auto";
      element.style.height = `${Math.max(400, element.scrollHeight)}px`;
    };
    resize();
    let width = element.parentElement?.getBoundingClientRect().width;
    const observer = new ResizeObserver((entries) => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth !== width) {
        width = nextWidth;
        resize();
      }
    });
    if (element.parentElement) observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [chapter?.content, chapter?.id, focus, notes]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 10000);
    return () => clearTimeout(timer);
  }, [notice]);

  const openBook = (b: Book) => {
    setBookId(b.id);
    setChapterId(b.chapters[0]?.id ?? null);
    setNotes(false);
    setQuery("");
  };
  const patch = (change: Partial<Book>) => {
    if (book) {
      try {
        updateBook({ ...book, ...change });
      } catch (e) {
        setNotice(errorMessage(e));
      }
    }
  };
  const patchChapter = (change: { title?: string; content?: string }) => {
    if (book && chapter)
      patch({
        chapters: book.chapters.map((c) =>
          c.id === chapter.id ? { ...c, ...change } : c,
        ),
      });
  };
  const addChapter = () => {
    if (!book) return;
    const c = {
      id: crypto.randomUUID(),
      title: `Chapter ${book.chapters.length + 1}`,
      content: "",
    };
    patch({ chapters: [...book.chapters, c] });
    setChapterId(c.id);
  };
  const moveChapter = (direction: number) => {
    if (!book || !chapter) return;
    const chapters = [...book.chapters];
    const index = chapters.findIndex((c) => c.id === chapter.id);
    const other = index + direction;
    if (other < 0 || other >= chapters.length) return;
    [chapters[index], chapters[other]] = [chapters[other], chapters[index]];
    patch({ chapters });
  };
  const exportBook = async () => {
    if (!book) return;
    try {
      const content = exportMarkdown(book);
      if (isDesktop) {
        const saved = await invoke<boolean>("export_manuscript", {
          title: book.title,
          content,
        });
        if (saved)
          setNotice("Manuscript exported. Your writing stays here, too.");
      } else {
        const url = URL.createObjectURL(
          new Blob([content], { type: "text/markdown;charset=utf-8" }),
        );
        const a = document.createElement("a");
        a.href = url;
        a.download = `${book.title.replace(/[^\p{L}\p{N} _-]/gu, "") || "Manuscript"}.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice("Markdown export downloaded.");
      }
    } catch (e) {
      setNotice(
        `Export failed: ${typeof e === "object" && e && "message" in e ? e.message : String(e)}`,
      );
    }
  };
  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024)
        throw new Error("Please select a manuscript smaller than 10 MB.");
      if (!/\.(txt|md|markdown)$/i.test(file.name))
        throw new Error("Choose a .txt or .md manuscript.");
      const b = importMarkdown(await file.text(), file.name);
      updateBook(b);
      openBook(b);
      setNotice(
        "Imported as a new manuscript. The original file is unchanged.",
      );
    } catch (e) {
      setNotice(String(e));
    }
    if (fileInput.current) fileInput.current.value = "";
  };
  const loadHistory = async (trigger?: HTMLElement) => {
    if (!book) return;
    const request = ++historyRequest.current;
    openModal("history", trigger);
    setHistoryBusy(true);
    setHistoryError("");
    setSnapshot(null);
    setVersions([]);
    try {
      await flush();
      const result = await library.listVersions(book.id);
      if (request === historyRequest.current) setVersions(result);
    } catch (e) {
      if (request === historyRequest.current) setHistoryError(errorMessage(e));
    } finally {
      if (request === historyRequest.current) setHistoryBusy(false);
    }
  };
  const readSnapshot = async (version: Version) => {
    if (!book) return;
    const request = ++historyRequest.current;
    setHistoryBusy(true);
    setHistoryError("");
    try {
      const result = await library.readVersion(book.id, version.id);
      if (request === historyRequest.current) setSnapshot(result);
    } catch (e) {
      if (request === historyRequest.current) setHistoryError(errorMessage(e));
    } finally {
      if (request === historyRequest.current) setHistoryBusy(false);
    }
  };
  const restoreCopy = () => {
    if (!snapshot) return;
    const copy = {
      ...snapshot,
      id: crypto.randomUUID(),
      title: `${Array.from(snapshot.title).slice(0, 225).join("")} — recovered`,
      revision: 0,
      updatedAt: new Date().toISOString(),
      chapters: snapshot.chapters.map((c) => ({
        ...c,
        id: crypto.randomUUID(),
      })),
    };
    try {
      updateBook(copy);
      setModal(null);
      openBook(copy);
      setNotice("Saved as a separate recovered manuscript.");
    } catch (e) {
      setHistoryError(errorMessage(e));
    }
  };
  const createSample = () => {
    const sample = createBook("The shape of quiet", "A sample manuscript");
    const content =
      "The house had been empty for eleven years when someone opened a window.\n\nMara noticed it on her morning walk, just as the mist began to lift from the harbor. The blue curtain moved once, then settled. Behind it, the room was dark.\n\nShe stopped beside the low stone wall. In all the years she had walked this road, in every season and every kind of weather, that window had stayed shut. She knew the house by its silences: the garden gate that never swung, the gravel that never crunched, the chimney that never carried smoke into the pale sky.\n\nNow, somewhere inside, a kettle was beginning to sing.\n\nShe could have kept walking. Later she would return to that thought, turning it over like a stone in her pocket. She could have passed the house and bought her bread and gone home by the long road. Nothing had asked her to stop.\n\nBut the curtain moved again, and a hand appeared on the sill. An ordinary hand, resting in the ordinary light of an October morning.\n\n“Hello?” Mara said.\n\nThe kettle fell silent.";
    const b = {
      ...sample,
      description: "A house, a stranger, and the things we leave unsaid.",
      goal: 60000,
      chapters: [
        { id: crypto.randomUUID(), title: "The open window", content },
        { id: crypto.randomUUID(), title: "An ordinary stranger", content: "" },
        { id: crypto.randomUUID(), title: "The long road home", content: "" },
      ],
      notes:
        "This is a sample you can edit freely.\n\nA question to follow: Why did the house stay empty for eleven years?",
    };
    updateBook(b);
    openBook(b);
  };
  const filtered = books
    .filter((b) =>
      `${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "title"
        ? a.title.localeCompare(b.title)
        : b.updatedAt.localeCompare(a.updatedAt),
    );

  return (
    <div
      inert={closing}
      className={`app ${book ? "writing" : "browsing"} ${focus ? "focus-mode" : ""}`}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".txt,.md,.markdown"
        className="visually-hidden"
        aria-label="Import manuscript file"
        onChange={(e) => importFile(e.target.files?.[0])}
      />
      {!focus && (
        <aside className="sidebar">
          <button
            className="brand"
            onClick={() => {
              setBookId(null);
              setFocus(false);
            }}
            aria-label="NEO Minimal home"
          >
            <span className="brand-mark">
              n<span>•</span>
            </span>
            <span>
              NEO<span className="brand-edition">MINIMAL</span>
            </span>
          </button>
          {book ? (
            <>
              <button
                className="back-link"
                onClick={() => {
                  setBookId(null);
                  setNotes(false);
                }}
              >
                <ArrowLeft size={15} />
                Your library
              </button>
              <div className="sidebar-book">
                <span className="eyebrow">MANUSCRIPT</span>
                <h2>{book.title}</h2>
                <p>{book.author || "A work in progress"}</p>
              </div>
              <div className="section-label">
                Chapters{" "}
                <IconButton
                  className="icon-button"
                  onClick={addChapter}
                  aria-label="Add chapter"
                >
                  <Plus size={16} />
                </IconButton>
              </div>
              <nav className="chapter-list" aria-label="Chapters">
                {book.chapters.map((c, i) => (
                  <button
                    key={c.id}
                    className={`chapter-link ${chapter?.id === c.id ? "active" : ""}`}
                    onClick={() => {
                      setChapterId(c.id);
                      setNotes(false);
                    }}
                  >
                    {chapter?.id === c.id && (
                      <motion.span
                        className="chapter-highlight"
                        layoutId="selected-chapter"
                        transition={{ duration: reduceMotion ? 0 : 0.18 }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="chapter-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="chapter-name">
                      {c.title || "Untitled chapter"}
                      <small>{number(words(c.content))} words</small>
                    </span>
                  </button>
                ))}
              </nav>
              <button
                className={`sidebar-action ${notes ? "active" : ""}`}
                onClick={() => setNotes((v) => !v)}
              >
                <FileText size={17} />
                Story notes
              </button>
              <div className="sidebar-bottom">
                <div className="progress-label">
                  <span>{number(total)} words</span>
                  <button
                    onClick={event => openModal("details", event.currentTarget)}
                    aria-label="Edit word goal"
                  >
                    {book.goal ? `${Math.round(percent)}%` : "Set goal"}
                  </button>
                </div>
                {book.goal > 0 && (
                  <>
                    <Progress
                      className="progress-track"
                      value={percent}
                      aria-label="Manuscript word goal"
                    />
                    <p className="goal-caption">
                      of {number(book.goal)} · one word at a time
                    </p>
                  </>
                )}
                <button
                  className="sidebar-action"
                  onClick={event => openModal("details", event.currentTarget)}
                >
                  <Settings2 size={16} />
                  Book details
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="sidebar-section">WORKSPACE</div>
              <nav aria-label="Workspace">
                <button
                  className="nav-link active"
                  onClick={() => setQuery("")}
                >
                  <Library size={18} />
                  <span>All manuscripts</span>
                  <span className="count">{books.length}</span>
                </button>
                <button
                  className="nav-link"
                  onClick={() => fileInput.current?.click()}
                  disabled={!ready}
                >
                  <Upload size={17} />
                  <span>Import manuscript</span>
                </button>
              </nav>
              <TypewriterQuote />
              <div className="sidebar-bottom">
                <div className="local-label">
                  <span className="status-dot" />
                  {isDesktop ? "A space of your own" : "Browser preview"}
                </div>
                <p className="local-caption">
                  {isDesktop
                    ? "Your words. On your computer."
                    : "Saved in this browser only."}
                </p>
              </div>
            </>
          )}
          <div className="sidebar-footer">
            <span>Made for the writing.</span>
            <IconButton
              className="icon-button"
              aria-label="Help and keyboard shortcuts"
              onClick={event => openModal("help", event.currentTarget)}
            >
              <CircleHelp size={16} />
            </IconButton>
          </div>
        </aside>
      )}
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            {book ? (
              <>
                <button
                  onClick={() => {
                    setBookId(null);
                    setFocus(false);
                  }}
                >
                  Library
                </button>
                <ChevronRight size={13} />
                <span>{book.title}</span>
                <Badge variant="outline" className="draft-tag">
                  DRAFT
                </Badge>
              </>
            ) : (
              <>
                <Library size={16} />
                <span>Your library</span>
              </>
            )}
          </div>
          <div className="topbar-actions">
            {book && (
              <>
                <span className={`save-indicator ${saveState}`} role="status">
                  {saveState === "saving" ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : saveState === "error" ? (
                    <span className="error-dot" />
                  ) : (
                    <Check size={14} />
                  )}
                  <span>
                    {saveState === "saving"
                      ? "Saving…"
                      : saveState === "error"
                        ? "Not saved"
                        : isDesktop
                          ? "Saved locally"
                          : "Saved in browser"}
                  </span>
                </span>
                <Separator
                  orientation="vertical"
                  className="toolbar-separator"
                />
                <IconButton
                  className={`icon-button ${focus ? "selected" : ""}`}
                  aria-label={focus ? "Exit focus mode" : "Enter focus mode"}
                  title="Focus mode · ⌘⇧F"
                  onClick={() => setFocus((v) => !v)}
                >
                  {focus ? <PanelLeftClose size={17} /> : <Focus size={17} />}
                </IconButton>
                <IconButton
                  className="icon-button"
                  aria-label="Version history"
                  title="Version history"
                  onClick={event => loadHistory(event.currentTarget)}
                >
                  <History size={17} />
                </IconButton>
                <button className="export-button" onClick={exportBook}>
                  <ArrowDownToLine size={16} />
                  <span>Export</span>
                </button>
              </>
            )}
            {!book && (
              <span className="quiet-label">
                <span className="status-dot" />
                {isDesktop ? "Local & private" : "Browser preview"}
              </span>
            )}
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => retry().catch(() => {})}>
              Retry saving / loading
            </button>
            {book && <button onClick={exportBook}>Export a copy</button>}
          </div>
        )}
        {recoveryNotice && (
          <div className="recovery-banner" role="status">
            {recoveryNotice}
          </div>
        )}
        <AnimatePresence>
          {notice && (
            <motion.div
              key={notice}
              className="notice"
              role="status"
              style={{ x: "-50%" }}
              initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
            >
              {notice}
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        {!book ? (
          <motion.main key="library" className="library-main" {...entrance}>
            <div className="library-heading">
              <div>
                <span className="eyebrow">A PLACE FOR YOUR WORDS</span>
                <h1>Your writing, at home.</h1>
                <p>
                  A little less noise. A little more room for your next chapter.
                </p>
              </div>
              <Button
                className="primary"
                disabled={!ready}
                onClick={event => openModal("new", event.currentTarget)}
              >
                <Plus size={17} />
                New manuscript
              </Button>
            </div>
            <div className="library-tools">
              <div className="manuscript-count">
                Manuscripts <span>{books.length}</span>
              </div>
              <div className="filter-tools">
                <label className="search-field">
                  <Search size={16} />
                  <Input
                    aria-label="Search manuscripts"
                    placeholder="Find a manuscript"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
                <Select
                  value={sort}
                  onValueChange={setSort}
                  open={sortOpen && !closing}
                  onOpenChange={setSortOpen}
                >
                  <SelectTrigger
                    className="sort-control"
                    aria-label="Sort manuscripts"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="recent">Recently edited</SelectItem>
                    <SelectItem value="title">Title, A to Z</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {loading ? (
              <div className="empty-state">
                <LoaderCircle className="spin" />
                <h2>Opening your library…</h2>
              </div>
            ) : books.length === 0 ? (
              <div className="empty-state">
                <div className="paper-stack">
                  <div />
                  <div />
                  <div>
                    <span />
                    <span />
                    <span />
                    <span />
                    <span className="paper-cursor" />
                  </div>
                </div>
                <span className="eyebrow">EVERY BOOK BEGINS SOMEWHERE</span>
                <h2>Make room for a story.</h2>
                <p>
                  A first sentence, a half-formed idea, a world only you know.
                  <br />
                  There’s a place for it here.
                </p>
                <Button
                  className="primary"
                  disabled={!ready}
                  onClick={event => openModal("new", event.currentTarget)}
                >
                  Start your first manuscript
                  <ArrowRight size={16} />
                </Button>
                <button
                  className="text-button"
                  disabled={!ready}
                  onClick={createSample}
                >
                  Or explore a sample
                  <ArrowRight size={14} />
                </button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="empty-state">
                <Search size={28} />
                <h2>No manuscripts found.</h2>
                <button className="text-button" onClick={() => setQuery("")}>
                  Clear search
                </button>
              </div>
            ) : (
              <motion.div
                className="book-grid"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
              >
                {filtered.map((b, i) => {
                  const count = totalWords(b);
                  return (
                    <motion.button
                      whileHover={reduceMotion ? undefined : { y: -3 }}
                      whileTap={reduceMotion ? undefined : { scale: 0.99 }}
                      className="book-card"
                      key={b.id}
                      onClick={() => openBook(b)}
                    >
                      <div className={`book-cover color-${i % 4}`}>
                        <span className="cover-top">A WORK IN PROGRESS</span>
                        <div className="cover-center">
                          <span className="cover-rule" />
                          <h2>{b.title}</h2>
                          <span className="cover-rule" />
                        </div>
                        <span className="cover-author">
                          {b.author || "An untold story"}
                        </span>
                        <span className="cover-spine" />
                      </div>
                      <div className="book-card-info">
                        <div>
                          <h3>{b.title}</h3>
                          <ArrowRight size={15} />
                        </div>
                        <p>
                          {number(count)} words
                          <span>Edited {date(b.updatedAt)}</span>
                        </p>
                        <Progress
                          className="card-progress"
                          value={
                            b.goal ? Math.min(100, (count / b.goal) * 100) : 0
                          }
                          aria-label={`${b.title} word goal`}
                        />
                      </div>
                    </motion.button>
                  );
                })}
                <button
                  className="new-book-card"
                  disabled={!ready}
                  onClick={event => openModal("new", event.currentTarget)}
                >
                  <span>
                    <Plus size={24} />
                  </span>
                  <h3>Something new</h3>
                  <p>Every idea deserves a page.</p>
                </button>
              </motion.div>
            )}
            <footer className="library-footer">
              <span>Independent by design. Inspired by NEO.</span>
              <span>No accounts. No subscriptions. Just words.</span>
            </footer>
          </motion.main>
        ) : (
          <motion.main key={book.id} className="editor-layout" {...entrance}>
            <div className="manuscript-scroll">
              <article className="manuscript">
                <div className="chapter-meta">
                  <span className="eyebrow">
                    CHAPTER{" "}
                    {String(
                      book.chapters.findIndex((c) => c.id === chapter?.id) + 1,
                    ).padStart(2, "0")}
                  </span>
                  <div className="chapter-controls">
                    <IconButton
                      className="icon-button"
                      title="Move chapter earlier"
                      aria-label="Move chapter earlier"
                      disabled={book.chapters[0]?.id === chapter?.id}
                      onClick={() => moveChapter(-1)}
                    >
                      <ChevronLeft size={14} />
                    </IconButton>
                    <IconButton
                      className="icon-button"
                      title="Move chapter later"
                      aria-label="Move chapter later"
                      disabled={book.chapters.at(-1)?.id === chapter?.id}
                      onClick={() => moveChapter(1)}
                    >
                      <ChevronRight size={14} />
                    </IconButton>
                  </div>
                </div>
                <input
                  className="chapter-title"
                  aria-label="Chapter title"
                  value={chapter?.title ?? ""}
                  maxLength={200}
                  onChange={(e) => patchChapter({ title: e.target.value })}
                  placeholder="An untitled beginning"
                />
                <div className="chapter-ornament">
                  <span />
                  <span>✦</span>
                  <span />
                </div>
                <textarea
                  key={chapter?.id}
                  ref={editor}
                  className="prose-editor"
                  aria-label="Manuscript text"
                  value={chapter?.content ?? ""}
                  onChange={(e) => patchChapter({ content: e.target.value })}
                  placeholder="Begin anywhere. The story will follow."
                  spellCheck={false}
                />
                <div className="chapter-end">
                  <span />
                  <span>END OF CHAPTER</span>
                  <span />
                </div>
                <button className="text-button add-next" onClick={addChapter}>
                  <Plus size={15} />
                  Add the next chapter
                </button>
              </article>
            </div>
            <AnimatePresence initial={false}>
              {notes && !focus && (
                <motion.aside
                  className="notes-panel"
                  key="notes"
                  initial={{ opacity: 0, x: reduceMotion ? 0 : 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: reduceMotion ? 0 : 12 }}
                >
                  <div>
                    <h2>Story notes</h2>
                    <IconButton
                      className="icon-button"
                      onClick={() => setNotes(false)}
                      aria-label="Close story notes"
                    >
                      <X size={16} />
                    </IconButton>
                  </div>
                  <p>A place for the things you don’t want to forget.</p>
                  <Textarea
                    aria-label="Story notes"
                    value={book.notes}
                    onChange={(e) => patch({ notes: e.target.value })}
                    placeholder="A character. A question. A loose thread…"
                  />
                </motion.aside>
              )}
            </AnimatePresence>
            <footer className="editor-footer">
              <span>
                {number(words(chapter?.content ?? ""))} words in this chapter
              </span>
              <span>
                {Math.max(1, Math.ceil(words(chapter?.content ?? "") / 200))}{" "}
                min read<span className="footer-dot">·</span>
                {focus
                  ? "Esc to leave focus mode"
                  : "Your story, at your pace."}
              </span>
            </footer>
          </motion.main>
        )}
      </div>
      {modal === "new" && (
        <Modal restoreFocusTo={modalOpener.current} title="A new beginning" onClose={() => setModal(null)}>
          <p className="dialog-intro">
            Give your story a name. You can always change it.
          </p>
          <BookForm
            onClose={() => setModal(null)}
            onSave={(title, author, goal) => {
              try {
                const b = createBook(title, author);
                updateBook({ ...b, goal });
                openBook(b);
                setModal(null);
              } catch (e) {
                setNotice(errorMessage(e));
              }
            }}
          />
        </Modal>
      )}
      {modal === "details" && book && (
        <Modal restoreFocusTo={modalOpener.current} title="Book details" onClose={() => setModal(null)}>
          <BookForm
            book={book}
            onClose={() => setModal(null)}
            onSave={(title, author, goal, description) => {
              patch({ title, author, goal, description });
              setModal(null);
            }}
          />
        </Modal>
      )}
      {modal === "history" && (
        <Modal restoreFocusTo={modalOpener.current} title="Earlier drafts" onClose={() => setModal(null)}>
          <p className="dialog-intro">
            Return to an earlier draft as a new manuscript. Your current writing
            stays intact.
          </p>
          {historyError && (
            <p role="alert" className="history-error">
              {historyError}
            </p>
          )}
          {historyBusy && <p className="muted">Loading drafts…</p>}
          {snapshot ? (
            <>
              <button className="text-button" onClick={() => setSnapshot(null)}>
                <ArrowLeft size={14} />
                All versions
              </button>
              <div className="snapshot">
                <h3>{snapshot.title}</h3>
                <p>
                  {number(totalWords(snapshot))} words ·{" "}
                  {snapshot.chapters.length} chapters
                </p>
                <pre>
                  {snapshot.chapters[0]?.content.slice(0, 1600) ||
                    "This draft has no text yet."}
                </pre>
              </div>
              <Button className="primary" onClick={restoreCopy}>
                Recover as a new manuscript
              </Button>
            </>
          ) : (
            <div className="version-list">
              {!historyBusy && versions.length === 0 && (
                <p className="muted">
                  Earlier drafts appear here after your next save.
                </p>
              )}
              {versions.map((v) => (
                <button
                  key={v.id}
                  disabled={historyBusy}
                  onClick={() => readSnapshot(v)}
                >
                  <History size={16} />
                  <span>
                    {new Date(v.createdAt).toLocaleString()}
                    <small>
                      Revision {v.revision} · {v.title}
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
      {modal === "help" && (
        <Modal restoreFocusTo={modalOpener.current} title="A quieter writing desk" onClose={() => setModal(null)}>
          <p className="dialog-intro">
            NEO Minimal is an independent, local-first reimagining of Hugh
            Howey’s NEO. Built for a blank page and a little momentum.
          </p>
          <dl className="shortcuts">
            <div>
              <dt>Save now</dt>
              <dd>⌘ / Ctrl S</dd>
            </div>
            <div>
              <dt>Focus mode</dt>
              <dd>⌘ / Ctrl Shift F</dd>
            </div>
            <div>
              <dt>Leave focus mode</dt>
              <dd>Esc</dd>
            </div>
            <div>
              <dt>This little guide</dt>
              <dd>⌘ / Ctrl /</dd>
            </div>
          </dl>
          <p className="help-copy">
            Add chapters from the sidebar. Rearrange them with the arrows above
            the chapter title. Notes and book details stay out of the way until
            you need them.
          </p>
          <p className="help-copy">
            Import plain text or Markdown. Export your manuscript as Markdown.
            This edition uses plain text; rich formatting, EPUB, and Word export
            are not included.
          </p>
          <p className="help-copy">
            {isDesktop
              ? "Manuscripts are saved by Rust to this app’s local data folder, with earlier drafts for recovery. No writing is sent to a server."
              : "You are using the browser preview. Writing is saved only in this browser’s storage. Export a copy before clearing browser data; the desktop app uses Rust and local files."}
          </p>
          <p className="help-credit">
            Based on NEO by Hugh Howey · MIT license
          </p>
        </Modal>
      )}
    </div>
  );
}
