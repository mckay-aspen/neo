import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { EditorContent, Extension, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import {
  Bold, Italic, Underline, Strikethrough, Highlighter, Code, Heading1,
  Heading2, Heading3, List, ListOrdered, Quote, SquareCode, Link, Undo2, Redo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MAX_COMMENT_BYTES } from '@/lib/review';
import type { RichDocument, RichNode } from '@/lib/review-types';
import './rich-comment-editor.css';

export { MAX_COMMENT_BYTES } from '@/lib/review';
const encoder = new TextEncoder();
const emptyParagraph = (): RichNode => ({ type: 'paragraph' });
const plainMarks = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'highlight']);

/** Shared by the editor and static renderer; never infer a protocol or accept relative links. */
export function safeCommentUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const href = value.trim();
  if (!href || href.length > 2_048 || /[\u0000-\u0020\u007f-\u009f\s]/u.test(href) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(href)) return null;
  try {
    const url = new URL(href);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return href;
    if (url.protocol === 'mailto:' && url.pathname) return href;
  } catch { /* Malformed or relative links remain plain text. */ }
  return null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function children(value: unknown): unknown[] {
  const content = object(value).content;
  return Array.isArray(content) ? content : [];
}

function safeMarks(value: unknown): NonNullable<RichNode['marks']> {
  if (!Array.isArray(value)) return [];
  const marks: NonNullable<RichNode['marks']> = [];
  const seen = new Set<string>();
  for (const item of value) {
    const mark = object(item);
    const type = typeof mark.type === 'string' ? mark.type : '';
    if (seen.has(type)) continue;
    seen.add(type);
    if (plainMarks.has(type)) marks.push({ type });
    else if (type === 'link') {
      const href = safeCommentUrl(object(mark.attrs).href);
      if (href) marks.push({ type, attrs: { href } });
    }
  }
  // ProseMirror's code mark excludes other marks.
  return seen.has('code') ? [{ type: 'code' }] : marks;
}

function inlineNodes(values: unknown[], depth: number): RichNode[] {
  if (depth > 20) return [];
  return values.flatMap((value): RichNode[] => {
    const node = object(value);
    if (node.type === 'hardBreak') return [{ type: 'hardBreak' }];
    if (typeof node.text === 'string' && node.text) {
      const marks = safeMarks(node.marks);
      return [{ type: 'text', text: node.text, ...(marks.length ? { marks } : {}) }];
    }
    return inlineNodes(children(value), depth + 1);
  });
}

function blockNodes(values: unknown[], depth: number): RichNode[] {
  if (depth > 20) return [];
  const result: RichNode[] = [];
  let looseInline: RichNode[] = [];
  const flush = () => {
    if (looseInline.length) result.push({ type: 'paragraph', content: looseInline });
    looseInline = [];
  };
  for (const value of values) {
    const node = object(value);
    if (node.type === 'text' || node.type === 'hardBreak' || typeof value === 'string') {
      looseInline.push(...inlineNodes([typeof value === 'string' ? { type: 'text', text: value } : value], depth + 1));
      continue;
    }
    flush();
    const content = children(value);
    if (node.type === 'paragraph' || node.type === 'heading') {
      const inline = inlineNodes(content, depth + 1);
      const level = object(node.attrs).level;
      result.push({
        type: node.type,
        ...(node.type === 'heading' ? { attrs: { level: level === 2 || level === 3 ? level : 1 } } : {}),
        ...(inline.length ? { content: inline } : {}),
      });
    } else if (node.type === 'codeBlock') {
      const text = inlineNodes(content, depth + 1).map(part => part.type === 'hardBreak' ? '\n' : part.text ?? '').join('');
      result.push({ type: 'codeBlock', ...(text ? { content: [{ type: 'text', text }] } : {}) });
    } else if (node.type === 'horizontalRule') {
      result.push({ type: 'horizontalRule' });
    } else if (node.type === 'blockquote') {
      const blocks = blockNodes(content, depth + 1);
      result.push({ type: 'blockquote', content: blocks.length ? blocks : [emptyParagraph()] });
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      const items = content.map(item => {
        const blocks = blockNodes(object(item).type === 'listItem' ? children(item) : [item], depth + 1);
        if (blocks[0]?.type !== 'paragraph') blocks.unshift(emptyParagraph());
        return { type: 'listItem', content: blocks };
      });
      const start = object(node.attrs).start;
      result.push({
        type: node.type,
        ...(node.type === 'orderedList' ? { attrs: { start: typeof start === 'number' && Number.isSafeInteger(start) && start > 0 ? start : 1 } } : {}),
        content: items.length ? items : [{ type: 'listItem', content: [emptyParagraph()] }],
      });
    } else {
      // Retain text inside unknown legacy wrappers, without rendering their attributes or tags.
      result.push(...blockNodes(content, depth + 1));
      if (!content.length && typeof node.text === 'string' && node.text) {
        result.push({ type: 'paragraph', content: [{ type: 'text', text: node.text }] });
      }
    }
  }
  flush();
  return result;
}

export function normalizeCommentDocument(value: unknown): RichDocument {
  const blocks = blockNodes(object(value).type === 'doc' ? children(value) : [value], 0);
  return { type: 'doc', content: blocks.length ? blocks : [emptyParagraph()] };
}

function renderNode(node: RichNode, key: string): ReactNode {
  if (node.type === 'text') {
    let content: ReactNode = node.text ?? '';
    for (const mark of [...(node.marks ?? [])].reverse()) {
      switch (mark.type) {
        case 'bold': content = <strong>{content}</strong>; break;
        case 'italic': content = <em>{content}</em>; break;
        case 'underline': content = <u>{content}</u>; break;
        case 'strike': content = <s>{content}</s>; break;
        case 'code': content = <code>{content}</code>; break;
        case 'highlight': content = <mark>{content}</mark>; break;
        case 'link': {
          const href = safeCommentUrl(mark.attrs?.href);
          if (href) content = <a href={href} target="_blank" rel="noopener noreferrer">{content}</a>;
          break;
        }
      }
    }
    return <Fragment key={key}>{content}</Fragment>;
  }
  const content = node.content?.map((child, index) => renderNode(child, `${key}-${index}`));
  switch (node.type) {
    case 'paragraph': return <p key={key}>{content ?? <br />}</p>;
    case 'heading': return node.attrs?.level === 3 ? <h3 key={key}>{content}</h3>
      : node.attrs?.level === 2 ? <h2 key={key}>{content}</h2> : <h1 key={key}>{content}</h1>;
    case 'blockquote': return <blockquote key={key}>{content}</blockquote>;
    case 'bulletList': return <ul key={key}>{content}</ul>;
    case 'orderedList': return <ol key={key} start={Number(node.attrs?.start) || 1}>{content}</ol>;
    case 'listItem': return <li key={key}>{content}</li>;
    case 'codeBlock': return <pre key={key}><code>{content}</code></pre>;
    case 'hardBreak': return <br key={key} />;
    case 'horizontalRule': return <hr key={key} />;
    default: return <Fragment key={key}>{content}</Fragment>;
  }
}

/** Saved comments require no editor instance and never interpret stored HTML. */
export function RichCommentContent({ value }: { value: RichDocument }) {
  const doc = useMemo(() => normalizeCommentDocument(value), [value]);
  return <div className="rich-comment-content rich-comment-prose">{doc.content?.map((node, index) => renderNode(node, String(index)))}</div>;
}

interface RichCommentEditorProps {
  value: RichDocument;
  onChange: (doc: RichDocument) => void;
  label: string;
  disabled?: boolean;
  autoFocus?: boolean;
}

function documentSize(doc: ProseMirrorNode) {
  let nodes = 0;
  let depth = 0;
  const visit = (node: ProseMirrorNode, level: number) => {
    nodes++;
    depth = Math.max(depth, level);
    if (level <= 21 && nodes <= 5_001) node.forEach(child => visit(child, level + 1));
  };
  visit(doc, 1);
  return { bytes: encoder.encode(doc.textContent).length, nodes, depth };
}

export function RichCommentEditor({ value, onChange, label, disabled = false, autoFocus = false }: RichCommentEditorProps) {
  const id = useId();
  const callback = useRef(onChange);
  callback.current = onChange;
  const alive = useRef(true);
  const [limitMessage, setLimitMessage] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkError, setLinkError] = useState('');
  const [toolbarFocus, setToolbarFocus] = useState(0);
  const linkInput = useRef<HTMLInputElement>(null);
  const savedSelection = useRef<{ from: number; to: number } | null>(null);
  const normalized = useMemo(() => normalizeCommentDocument(value), [value]);
  const incoming = JSON.stringify(normalized);
  const lastValue = useRef(incoming);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const textLimit = useMemo(() => Extension.create({
    name: 'commentTextLimit',
    addProseMirrorPlugins() {
      return [new Plugin({
        key: new PluginKey('commentTextLimit'),
        filterTransaction(transaction, state) {
          if (!transaction.docChanged || transaction.getMeta('commentExternalValue')) return true;
          const size = documentSize(transaction.doc);
          if (size.bytes <= MAX_COMMENT_BYTES && size.nodes <= 5_000 && size.depth <= 20) return true;
          const previous = documentSize(state.doc);
          // Existing oversized comments can still be shortened or simplified.
          if (size.bytes <= previous.bytes && size.nodes <= previous.nodes && size.depth <= previous.depth) return true;
          const message = size.bytes > MAX_COMMENT_BYTES
            ? 'Comments can contain up to 100 KB of text. Shorten this comment to keep writing.'
            : 'This comment has too many blocks or nested lists. Simplify its formatting to keep writing.';
          queueMicrotask(() => { if (alive.current) setLimitMessage(message); });
          return false;
        },
      })];
    },
  }), []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
          isAllowedUri: href => safeCommentUrl(href) !== null,
          HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
        },
      }),
      Highlight.configure({ multicolor: false }),
      textLimit,
    ],
    content: normalized,
    editable: !disabled,
    autofocus: autoFocus ? 'end' : false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: 'rich-comment-prose',
        role: 'textbox',
        'aria-label': label,
        'aria-multiline': 'true',
        'aria-describedby': `${id}-limit`,
      },
    },
    onUpdate: ({ editor: updated }) => {
      const doc = normalizeCommentDocument(updated.getJSON());
      lastValue.current = JSON.stringify(doc);
      setLimitMessage('');
      callback.current(doc);
    },
    onSelectionUpdate: ({ editor: updated }) => {
      if (savedSelection.current) {
        savedSelection.current = { from: updated.state.selection.from, to: updated.state.selection.to };
      }
    },
  });

  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => current ? {
      bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'),
      strike: current.isActive('strike'), highlight: current.isActive('highlight'), code: current.isActive('code'),
      heading1: current.isActive('heading', { level: 1 }), heading2: current.isActive('heading', { level: 2 }),
      heading3: current.isActive('heading', { level: 3 }), bulletList: current.isActive('bulletList'),
      orderedList: current.isActive('orderedList'), blockquote: current.isActive('blockquote'),
      codeBlock: current.isActive('codeBlock'), link: current.isActive('link'),
      canUndo: current.can().undo(), canRedo: current.can().redo(),
    } : null,
  });

  useEffect(() => {
    if (!editor || incoming === lastValue.current) return;
    lastValue.current = incoming;
    editor.chain().setMeta('commentExternalValue', true).setContent(normalized, { emitUpdate: false }).run();
    savedSelection.current = null;
    setLinkOpen(false);
    setLimitMessage('');
  }, [editor, incoming, normalized]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled, false);
    editor.view.dom.setAttribute('aria-disabled', String(disabled));
    editor.view.dom.setAttribute('aria-label', label);
    if (disabled) setLinkOpen(false);
  }, [editor, disabled, label]);

  useEffect(() => {
    if (linkOpen) linkInput.current?.focus();
  }, [linkOpen]);

  function openLink() {
    if (!editor || disabled) return;
    savedSelection.current = { from: editor.state.selection.from, to: editor.state.selection.to };
    setLinkValue(editor.getAttributes('link').href ?? '');
    setLinkError('');
    setLinkOpen(true);
  }

  function restoreSelection(current: Editor) {
    const selection = savedSelection.current;
    const chain = current.chain().focus();
    return selection ? chain.setTextSelection(selection) : chain;
  }

  function closeLink() {
    setLinkOpen(false);
    if (editor && !disabled) restoreSelection(editor).run();
  }

  function applyLink(remove = false) {
    if (!editor || disabled) return;
    const href = safeCommentUrl(linkValue);
    if (!remove && !href) {
      setLinkError('Enter a full https://, http://, or mailto: address.');
      linkInput.current?.focus();
      return;
    }
    const chain = restoreSelection(editor).extendMarkRange('link');
    if (remove) chain.unsetLink().run();
    else chain.setLink({ href: href! }).run();
    setLinkOpen(false);
  }

  const actions = [
    { label: 'Bold', icon: Bold, active: state?.bold, run: (e: Editor) => e.chain().focus().toggleBold().run() },
    { label: 'Italic', icon: Italic, active: state?.italic, run: (e: Editor) => e.chain().focus().toggleItalic().run() },
    { label: 'Underline', icon: Underline, active: state?.underline, run: (e: Editor) => e.chain().focus().toggleUnderline().run() },
    { label: 'Strikethrough', icon: Strikethrough, active: state?.strike, run: (e: Editor) => e.chain().focus().toggleStrike().run() },
    { label: 'Highlight', icon: Highlighter, active: state?.highlight, run: (e: Editor) => e.chain().focus().toggleHighlight().run() },
    { label: 'Inline code', icon: Code, active: state?.code, run: (e: Editor) => e.chain().focus().toggleCode().run() },
    { label: 'Heading 1', icon: Heading1, active: state?.heading1, run: (e: Editor) => e.chain().focus().toggleHeading({ level: 1 }).run() },
    { label: 'Heading 2', icon: Heading2, active: state?.heading2, run: (e: Editor) => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: 'Heading 3', icon: Heading3, active: state?.heading3, run: (e: Editor) => e.chain().focus().toggleHeading({ level: 3 }).run() },
    { label: 'Bullet list', icon: List, active: state?.bulletList, run: (e: Editor) => e.chain().focus().toggleBulletList().run() },
    { label: 'Numbered list', icon: ListOrdered, active: state?.orderedList, run: (e: Editor) => e.chain().focus().toggleOrderedList().run() },
    { label: 'Block quote', icon: Quote, active: state?.blockquote, run: (e: Editor) => e.chain().focus().toggleBlockquote().run() },
    { label: 'Code block', icon: SquareCode, active: state?.codeBlock, run: (e: Editor) => e.chain().focus().toggleCodeBlock().run() },
    { label: 'Link', icon: Link, active: state?.link, run: openLink },
    { label: 'Undo', icon: Undo2, unavailable: !state?.canUndo, run: (e: Editor) => e.chain().focus().undo().run() },
    { label: 'Redo', icon: Redo2, unavailable: !state?.canRedo, run: (e: Editor) => e.chain().focus().redo().run() },
  ];

  return <div className="rich-comment-editor" data-disabled={disabled || undefined}>
    <div className="rich-comment-toolbar" role="toolbar" aria-label={`${label} formatting`}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (!buttons.length) return;
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }}>
      {actions.map((action, index) => <Tooltip key={action.label}>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon-sm" className="rich-comment-tool"
            aria-label={action.label} aria-pressed={'active' in action ? Boolean(action.active) : undefined}
            aria-expanded={action.label === 'Link' ? linkOpen : undefined}
            aria-controls={action.label === 'Link' ? `${id}-link` : undefined}
            disabled={disabled || !editor || action.unavailable}
            tabIndex={(actions[toolbarFocus]?.unavailable ? 0 : toolbarFocus) === index ? 0 : -1}
            onFocus={() => setToolbarFocus(index)}
            onMouseDown={event => event.preventDefault()}
            onClick={() => { if (editor) action.run(editor); }}>
            <action.icon aria-hidden="true" size={15} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{action.label}</TooltipContent>
      </Tooltip>)}
    </div>
    {linkOpen && <div className="rich-comment-link" id={`${id}-link`} role="group" aria-label="Edit link">
      <label htmlFor={`${id}-url`}>Link address</label>
      <Input ref={linkInput} id={`${id}-url`} value={linkValue} placeholder="https://example.com"
        autoComplete="off" spellCheck={false} aria-invalid={Boolean(linkError)}
        aria-describedby={linkError ? `${id}-link-error` : undefined}
        onChange={event => { setLinkValue(event.target.value); setLinkError(''); }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); applyLink(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeLink(); }
        }} />
      {linkError && <p className="rich-comment-error" id={`${id}-link-error`} role="alert">{linkError}</p>}
      <div className="rich-comment-link-actions">
        <Button type="button" size="sm" onClick={() => applyLink()}>Apply link</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => applyLink(true)}>Remove link</Button>
        <Button type="button" size="sm" variant="ghost" onClick={closeLink}>Cancel</Button>
      </div>
    </div>}
    <EditorContent editor={editor} />
    <p id={`${id}-limit`} className="rich-comment-limit" role="status" aria-live="polite">{limitMessage}</p>
  </div>;
}
