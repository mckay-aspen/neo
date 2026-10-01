export interface RichNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: RichNode[];
}
export interface RichDocument extends RichNode { type: 'doc' }
export interface ReviewAnchor {
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
}
export type AnnotationKind = 'comment' | 'highlight' | 'strikethrough' | 'suggestion';
interface EventBase { id: string; threadId: string; at: string; actor: string }
export type ReviewEvent = EventBase & (
  | { type: 'thread_created'; chapterId: string; anchor: ReviewAnchor; kind: AnnotationKind; messageId: string; body: RichDocument; replacement?: string }
  | { type: 'reply_added' | 'message_edited'; messageId: string; body: RichDocument }
  | { type: 'message_deleted'; messageId: string }
  | { type: 'thread_resolved' | 'thread_reopened' }
  | { type: 'thread_reanchored'; chapterId: string; anchor: ReviewAnchor }
);
export interface ReviewData { version: 1; events: ReviewEvent[] }
export interface ReviewMessage {
  id: string; author: string; createdAt: string; body: RichDocument;
  editedAt?: string; deletedAt?: string;
}
export interface ReviewThread {
  id: string; chapterId: string; anchor: ReviewAnchor; kind: AnnotationKind;
  replacement?: string; author: string; createdAt: string; updatedAt: string;
  status: 'open' | 'resolved'; messages: ReviewMessage[];
}
export interface ResolvedAnchor {
  start: number; end: number; state: 'exact' | 'moved';
}
