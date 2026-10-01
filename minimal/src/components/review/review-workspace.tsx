import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CornerDownRight, Highlighter, History, MessageSquare, Pencil, RotateCcw, Strikethrough, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RichCommentContent, RichCommentEditor } from './rich-comment-editor';
import { ReviewDocument } from './review-document';
import { appendReviewEvent, reviewThreads, resolveAnchor, richText } from '@/lib/review';
import type { Book, Chapter } from '@/lib/types';
import { errorMessage } from '@/lib/types';
import type { AnnotationKind, ReviewAnchor, ReviewEvent, ReviewMessage, ReviewThread, RichDocument } from '@/lib/review-types';
import './review.css';

const emptyDocument = (): RichDocument => ({ type: 'doc', content: [{ type: 'paragraph' }] });
const textDocument = (text: string): RichDocument => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const displayTime = (time: string) => new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const kindLabel: Record<AnnotationKind, string> = { comment: 'Comment', highlight: 'Highlight', strikethrough: 'Strikethrough', suggestion: 'Suggestion' };
const eventLabel: Record<ReviewEvent['type'], string> = {
  thread_created: 'started a thread', reply_added: 'replied', message_edited: 'edited a comment',
  message_deleted: 'removed a comment', thread_resolved: 'resolved a thread', thread_reopened: 'reopened a thread', thread_reanchored: 'reattached a thread',
};
interface Composer {
  key: string; mode: 'new' | 'reply' | 'edit'; body: RichDocument; replacement: string;
  threadId?: string; messageId?: string; anchor?: ReviewAnchor; chapterId?: string; kind?: AnnotationKind;
}

export function ReviewWorkspace({ book, chapter, onChange, onChapter, onDraftChange }: {
  book: Book; chapter: Chapter; onChange: (book: Book) => void; onChapter: (id: string) => void;
  onDraftChange: (pending: boolean) => void;
}) {
  const threads = useMemo(() => reviewThreads(book.review), [book.review]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReviewAnchor | null>(null);
  const [composer, setComposer] = useState<Composer | null>(null);
  const [filter, setFilter] = useState('open');
  const [scope, setScope] = useState('chapter');
  const [tab, setTab] = useState<'threads' | 'activity'>('threads');
  const [activityLimit, setActivityLimit] = useState(100);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [actor, setActor] = useState(() => { try { return localStorage.getItem('neo-reviewer-name') || 'You'; } catch { return 'You'; } });
  const composerElement = useRef<HTMLDivElement>(null);
  const active = threads.find(thread => thread.id === activeId);
  const visibleThreads = threads.filter(thread => (scope === 'all' || thread.chapterId === chapter.id) && (filter === 'all' || thread.status === filter));
  const events = book.review?.events ?? [];

  useEffect(() => { setSelection(null); }, [chapter.id]);
  useEffect(() => { onDraftChange(composer !== null); return () => onDraftChange(false); }, [composer !== null, onDraftChange]);
  useEffect(() => { if (composer) composerElement.current?.scrollIntoView({ block: 'nearest' }); }, [composer?.key]);

  function reviewer() {
    const name = actor.trim();
    if (!name) throw new Error('Enter a reviewer name before posting.');
    try { localStorage.setItem('neo-reviewer-name', name); } catch { /* Names still travel with posted events. */ }
    return name;
  }
  function base(threadId: string) { return { id: crypto.randomUUID(), threadId, at: new Date().toISOString(), actor: reviewer() }; }
  function commit(event: ReviewEvent) {
    onChange(appendReviewEvent(book, event));
    setError('');
  }
  function newComposer(kind: AnnotationKind) {
    if (composer) { setError('Post or cancel your current comment first.'); return; }
    if (!selection) { setError('Select a passage in the manuscript first.'); return; }
    setComposer({ key: crypto.randomUUID(), mode: 'new', body: emptyDocument(), replacement: '', anchor: selection, chapterId: chapter.id, kind });
    setTab('threads'); setError('');
  }
  function startMessage(thread: ReviewThread, message?: ReviewMessage) {
    if (composer) { setError('Post or cancel your current comment first.'); return; }
    setActiveId(thread.id); setTab('threads'); setError('');
    setComposer({ key: crypto.randomUUID(), mode: message ? 'edit' : 'reply', body: message ? structuredClone(message.body) : emptyDocument(), replacement: '', threadId: thread.id, messageId: message?.id, chapterId: thread.chapterId, anchor: thread.anchor });
  }
  function submit() {
    if (!composer) return;
    try {
      let threadId = composer.threadId;
      if (composer.mode === 'new') {
        threadId = crypto.randomUUID();
        const kind = composer.kind!;
        const body = richText(composer.body).trim() ? composer.body
          : kind === 'highlight' ? textDocument('Highlighted passage.')
          : kind === 'strikethrough' ? textDocument('Suggested removal.')
          : kind === 'suggestion' ? textDocument('Suggested revision.') : composer.body;
        commit({ ...base(threadId), type: 'thread_created', chapterId: composer.chapterId!, anchor: composer.anchor!, kind,
          messageId: crypto.randomUUID(), body, ...(kind === 'suggestion' ? { replacement: composer.replacement } : {}) });
      } else {
        commit({ ...base(threadId!), type: composer.mode === 'edit' ? 'message_edited' : 'reply_added',
          messageId: composer.messageId ?? crypto.randomUUID(), body: composer.body });
      }
      setActiveId(threadId!); setComposer(null); setSelection(null); setFilter('all');
      const targetChapter = composer.chapterId ?? threads.find(thread => thread.id === threadId)?.chapterId;
      if (targetChapter && book.chapters.some(item => item.id === targetChapter)) onChapter(targetChapter);
      setAnnouncement('Comment added to the review. The manuscript is unchanged.');
    } catch (failure) { setError(errorMessage(failure)); }
  }
  function status(thread: ReviewThread) {
    try { commit({ ...base(thread.id), type: thread.status === 'open' ? 'thread_resolved' : 'thread_reopened' }); }
    catch (failure) { setError(errorMessage(failure)); }
  }
  function removeMessage(thread: ReviewThread, message: ReviewMessage) {
    try { commit({ ...base(thread.id), type: 'message_deleted', messageId: message.id }); }
    catch (failure) { setError(errorMessage(failure)); }
  }
  function reattach(thread: ReviewThread) {
    if (!selection) return;
    try { commit({ ...base(thread.id), type: 'thread_reanchored', chapterId: chapter.id, anchor: selection }); setSelection(null); }
    catch (failure) { setError(errorMessage(failure)); }
  }
  function chooseThread(id: string) {
    const thread = threads.find(item => item.id === id);
    if (!thread) return;
    setActiveId(id); setTab('threads'); setFilter('all');
    if (book.chapters.some(item => item.id === thread.chapterId)) onChapter(thread.chapterId);
    requestAnimationFrame(() => {
      document.getElementById(`review-thread-${id}`)?.scrollIntoView({ block: 'nearest' });
      document.querySelector(`[data-review-threads~="${id}"]`)?.scrollIntoView({ block: 'center' });
    });
  }

  return (
    <main className="review-workspace">
      <div className="review-tools" aria-label="Review tools">
        <div className="review-tool-heading"><MessageSquare size={16} /><strong>Review mode</strong><span>Original text stays unchanged</span></div>
        <div className="review-selection-tools">
          <span>{selection ? `${selection.end - selection.start} characters selected` : 'Select text to annotate'}</span>
          <Button size="sm" variant="ghost" disabled={!selection} onClick={() => newComposer('comment')}><MessageSquare size={14} />Comment</Button>
          <Button size="sm" variant="ghost" disabled={!selection} onClick={() => newComposer('highlight')}><Highlighter size={14} />Highlight</Button>
          <Button size="sm" variant="ghost" disabled={!selection} onClick={() => newComposer('strikethrough')}><Strikethrough size={14} />Strike</Button>
          <Button size="sm" variant="ghost" disabled={!selection} onClick={() => newComposer('suggestion')}><Pencil size={14} />Suggest</Button>
          {selection && <Button variant="ghost" size="icon" aria-label="Clear selection" onClick={() => setSelection(null)}><X size={14} /></Button>}
        </div>
      </div>
      <div className="review-columns">
        <ReviewDocument chapter={chapter} threads={threads} activeId={activeId} onSelect={anchor => { setSelection(anchor); setError(''); }} onThread={chooseThread} onError={setError} />
        <aside className="review-panel" aria-label="Comments and suggestions">
          <div className="review-panel-heading"><div><h2>Conversation</h2><p>{threads.filter(thread => thread.status === 'open').length} open threads · local review</p></div></div>
          <div className="reviewer-field"><Label htmlFor="reviewer-name">Reviewing as</Label><Input id="reviewer-name" maxLength={120} value={actor} onChange={event => setActor(event.target.value)} /></div>
          <div className="review-tabs" role="tablist" aria-label="Review panels">
            <Button variant="ghost" role="tab" aria-selected={tab === 'threads'} onClick={() => setTab('threads')}><MessageSquare size={14} />Threads</Button>
            <Button variant="ghost" role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}><History size={14} />Activity <span>{events.length}</span></Button>
          </div>
          {error && <p className="review-error" role="alert">{error}</p>}
          <span className="sr-only" role="status">{announcement}</span>
          {composer && <div className="review-composer" ref={composerElement}>
            <div className="review-composer-heading"><h3>{composer.mode === 'new' ? `New ${kindLabel[composer.kind!].toLowerCase()}` : composer.mode === 'edit' ? 'Edit comment' : 'Reply to thread'}</h3><Button variant="ghost" size="icon" aria-label="Cancel comment" onClick={() => { setComposer(null); setError(''); }}><X size={14} /></Button></div>
            {composer.anchor && <blockquote className="review-excerpt">{composer.anchor.quote}</blockquote>}
            {composer.chapterId && composer.chapterId !== chapter.id && <p className="composer-context">For {book.chapters.find(item => item.id === composer.chapterId)?.title || 'the original chapter'}</p>}
            {composer.kind === 'suggestion' && <div className="replacement-field"><Label htmlFor="replacement">Suggested wording</Label><Textarea id="replacement" value={composer.replacement} maxLength={20_000} onChange={event => setComposer({ ...composer, replacement: event.target.value })} placeholder="Your proposed wording…" /><p>Leave empty to suggest removing the selected passage.</p></div>}
            <RichCommentEditor key={composer.key} value={composer.body} onChange={body => setComposer(current => current ? { ...current, body } : null)} label={composer.mode === 'reply' ? 'Reply text' : 'Comment text'} autoFocus />
            <p className="comment-draft-notice">Unposted draft · {composer.mode === 'edit' ? 'save the edit' : 'post it'} to keep these changes.</p>
            <div className="review-composer-actions"><Button variant="ghost" size="sm" onClick={() => { setComposer(null); setError(''); }}>Cancel</Button><Button size="sm" onClick={submit} disabled={!richText(composer.body).trim() && (composer.mode !== 'new' || composer.kind === 'comment')}>{composer.mode === 'edit' ? 'Save edit' : composer.mode === 'reply' ? 'Post reply' : `Add ${kindLabel[composer.kind!].toLowerCase()}`}</Button></div>
          </div>}
          {tab === 'threads' ? <>
            <div className="review-filters">
              <Select value={filter} onValueChange={setFilter}><SelectTrigger aria-label="Thread status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="open">Open threads</SelectItem><SelectItem value="resolved">Resolved</SelectItem><SelectItem value="all">All threads</SelectItem></SelectContent></Select>
              <Select value={scope} onValueChange={setScope}><SelectTrigger aria-label="Thread scope"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="chapter">This chapter</SelectItem><SelectItem value="all">Entire manuscript</SelectItem></SelectContent></Select>
            </div>
            {!visibleThreads.length && <div className="review-empty"><MessageSquare size={24} /><h3>A second pair of eyes.</h3><p>Select a passage to leave a comment, mark it up, or suggest a change. Your words stay intact.</p></div>}
            <div className="review-thread-list">
              {visibleThreads.map(thread => {
                const sourceChapter = book.chapters.find(item => item.id === thread.chapterId);
                const location = sourceChapter ? resolveAnchor(sourceChapter.content, thread.anchor) : null;
                const expanded = thread.id === activeId;
                const messages = expanded ? thread.messages : thread.messages.slice(0, 1);
                return <section id={`review-thread-${thread.id}`} key={thread.id} className={`review-thread ${expanded ? 'active' : ''} ${thread.status === 'resolved' ? 'resolved' : ''}`}>
                  <button className="review-thread-summary" onClick={() => chooseThread(thread.id)} aria-expanded={expanded}>
                    <span className={`annotation-kind kind-${thread.kind}`}>{kindLabel[thread.kind]}</span><span>{thread.status === 'resolved' ? 'Resolved' : sourceChapter?.title || 'Chapter unavailable'}</span>
                    <blockquote>{thread.anchor.quote}</blockquote>
                  </button>
                  {!location && <p className="review-detached">Passage changed. The original selection is preserved above.</p>}
                  {expanded && selection && <Button size="sm" variant="ghost" className="reattach-button" onClick={() => reattach(thread)}>Attach to selected passage</Button>}
                  {thread.kind === 'suggestion' && <div className="review-diff" aria-label="Suggested text change"><del>{thread.anchor.quote}</del>{thread.replacement ? <ins>{thread.replacement}</ins> : <span>Remove this passage</span>}</div>}
                  {messages.map((message, index) => <div className={`review-message ${index ? 'reply' : ''}`} key={message.id}>
                    <div className="review-message-meta"><strong>{message.author}</strong><time dateTime={message.createdAt}>{displayTime(message.createdAt)}</time>{message.editedAt && <span>edited</span>}</div>
                    {message.deletedAt ? <p className="removed-comment">Comment removed. Earlier text is in Activity.</p> : <RichCommentContent value={message.body} />}
                    {expanded && !message.deletedAt && <div className="review-message-actions"><Button variant="ghost" size="sm" onClick={() => startMessage(thread, message)} aria-label={`Edit comment by ${message.author}`}><Pencil size={12} />Edit</Button><Button variant="ghost" size="sm" onClick={() => removeMessage(thread, message)} aria-label={`Remove comment by ${message.author}`}><Trash2 size={12} />Remove</Button></div>}
                  </div>)}
                  {!expanded && thread.messages.length > 1 && <button className="review-reply-count" onClick={() => chooseThread(thread.id)}><CornerDownRight size={13} />{thread.messages.length - 1} {thread.messages.length === 2 ? 'reply' : 'replies'}</button>}
                  <div className="review-thread-actions"><Button variant="ghost" size="sm" onClick={() => startMessage(thread)}><CornerDownRight size={14} />Reply</Button><Button variant="ghost" size="sm" onClick={() => status(thread)}>{thread.status === 'open' ? <Check size={14} /> : <RotateCcw size={14} />}{thread.status === 'open' ? 'Resolve' : 'Reopen'}</Button><Button variant="ghost" size="sm" onClick={() => { setActiveId(thread.id); setTab('activity'); }} aria-label="View thread activity"><History size={14} /></Button></div>
                </section>;
              })}
            </div>
          </> : <div className="review-activity">
            <div className="activity-heading"><h3>{active ? 'Thread history' : 'All review activity'}</h3>{active && <Button variant="ghost" size="sm" onClick={() => setActiveId(null)}>Show all</Button>}</div>
            <p className="audit-explanation">Every posted action is kept, including earlier comment text. Reviewer names are local labels, not verified identities.</p>
            {[...events].reverse().filter(event => !active || event.threadId === active.id).slice(0, activityLimit).map(event => <details className="audit-event" key={event.id}>
              <summary><span><strong>{event.actor}</strong> {eventLabel[event.type]}</span><time dateTime={event.at}>{displayTime(event.at)}</time></summary>
              {'anchor' in event && <blockquote className="review-excerpt">{event.anchor.quote}</blockquote>}
              {'replacement' in event && <p className="audit-replacement">Proposed: {event.replacement || '(remove passage)'}</p>}
              {'body' in event && <RichCommentContent value={event.body} />}
              <span className="audit-id">{event.id}</span>
            </details>)}
            {events.filter(event => !active || event.threadId === active.id).length > activityLimit && <Button variant="ghost" size="sm" onClick={() => setActivityLimit(value => value + 100)}>Show earlier activity</Button>}
            {!events.length && <p className="review-empty">Posted comments and review actions will appear here.</p>}
          </div>}
        </aside>
      </div>
    </main>
  );
}
