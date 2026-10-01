import { useMemo, useRef } from 'react';
import type { Chapter } from '@/lib/types';
import type { ReviewAnchor, ReviewThread } from '@/lib/review-types';
import { makeAnchor, resolveAnchor } from '@/lib/review';

export function ReviewDocument({ chapter, threads, activeId, onSelect, onThread, onError }: {
  chapter: Chapter;
  threads: ReviewThread[];
  activeId: string | null;
  onSelect: (anchor: ReviewAnchor | null) => void;
  onThread: (id: string) => void;
  onError: (message: string) => void;
}) {
  const prose = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => {
    const ranges = threads.filter(t => t.chapterId === chapter.id && (t.status === 'open' || t.id === activeId))
      .flatMap(thread => { const anchor = resolveAnchor(chapter.content, thread.anchor); return anchor ? [{ ...anchor, thread }] : []; });
    const boundaries = [...new Set([0, chapter.content.length, ...ranges.flatMap(r => [r.start, r.end])])].sort((a, b) => a - b);
    return boundaries.slice(0, -1).map((start, i) => ({
      start, end: boundaries[i + 1],
      threads: ranges.filter(r => r.start <= start && r.end > start).map(r => r.thread),
    }));
  }, [chapter.id, chapter.content, threads, activeId]);

  function captureSelection() {
    const element = prose.current;
    const selection = window.getSelection();
    if (!element || !selection || !selection.rangeCount) return;
    if (selection.isCollapsed) { onSelect(null); return; }
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
    const before = range.cloneRange();
    before.selectNodeContents(element);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    const end = start + range.toString().length;
    if (end - start > 20_000) { onSelect(null); onError('Select a passage shorter than 20,000 characters to annotate.'); return; }
    if (end > start) {
      try { onSelect(makeAnchor(chapter.content, start, end)); }
      catch { onSelect(null); onError('Select a complete passage within this chapter.'); }
    }
  }

  return (
    <div className="review-manuscript-scroll">
      <article className="review-manuscript">
        <p className="eyebrow">MANUSCRIPT · REVIEW COPY</p>
        <h1>{chapter.title || 'Untitled chapter'}</h1>
        <div className="chapter-ornament" aria-hidden="true"><span /><span>✦</span><span /></div>
        <div ref={prose} className="review-prose" role="document" aria-label="Manuscript for review" tabIndex={0}
          onMouseDown={() => onSelect(null)} onMouseUp={captureSelection} onKeyUp={captureSelection} onTouchEnd={captureSelection}>
          {segments.map(segment => {
            const text = chapter.content.slice(segment.start, segment.end);
            if (!segment.threads.length) return <span key={segment.start}>{text}</span>;
            const active = segment.threads.some(t => t.id === activeId);
            const marked = segment.threads.some(t => t.kind === 'highlight');
            const struck = segment.threads.some(t => t.kind === 'strikethrough' || t.kind === 'suggestion');
            const choose = () => {
              const index = segment.threads.findIndex(t => t.id === activeId);
              onThread(segment.threads[(index + 1) % segment.threads.length].id);
            };
            return <span key={segment.start} role="button" tabIndex={0}
              data-review-threads={segment.threads.map(t => t.id).join(' ')}
              className={`review-mark ${active ? 'selected' : ''} ${marked ? 'highlighted' : ''} ${struck ? 'struck' : ''}`}
              aria-label={`${segment.threads.length} ${segment.threads.length === 1 ? 'comment' : 'comments'} on: ${text.slice(0, 100)}`}
              onClick={() => { if (window.getSelection()?.isCollapsed) choose(); }}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } }}
            >{text}</span>;
          })}
        </div>
        {!chapter.content && <p className="review-empty-prose">This chapter is empty. Return to Write to add text before annotating it.</p>}
        <p className="review-end">END OF CHAPTER</p>
      </article>
    </div>
  );
}
