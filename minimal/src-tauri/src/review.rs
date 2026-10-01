//! Validated, append-only review events. JSON values preserve the submitted audit
//! payload without normalizing rich text or rewriting past events.
use crate::storage::{validate_id, StoreError};
use chrono::{DateTime, Timelike};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};

const MAX_REVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_EVENTS: usize = 10_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_BODY_BYTES: usize = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ReviewData {
    pub version: u8,
    pub events: Vec<Value>,
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new("INVALID_INPUT", message)
}

fn object<'a>(value: &'a Value, context: &str) -> Result<&'a Map<String, Value>, StoreError> {
    value
        .as_object()
        .ok_or_else(|| invalid(format!("{context} must be a JSON object.")))
}

fn keys(value: &Map<String, Value>, allowed: &[&str]) -> Result<(), StoreError> {
    if value.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("A review object contains an unsupported property."));
    }
    Ok(())
}

fn string<'a>(value: &'a Map<String, Value>, name: &str) -> Result<&'a str, StoreError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("Review {name} must be a string.")))
}

fn required<'a>(value: &'a Map<String, Value>, name: &str) -> Result<&'a Value, StoreError> {
    value
        .get(name)
        .ok_or_else(|| invalid(format!("Review {name} is required.")))
}

fn unsigned(value: &Value) -> Result<u64, StoreError> {
    value
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| {
            invalid("Review positions and numeric attributes must be safe nonnegative integers.")
        })
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn has_semantic_text(value: &str) -> bool {
    value.chars().any(|character| {
        !matches!(character,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}'
        )
    })
}

fn timestamp(value: &str) -> Result<(), StoreError> {
    let bytes = value.as_bytes();
    let fixed = bytes.len() >= 20
        && bytes.len() <= 35
        && bytes
            .iter()
            .take(19)
            .enumerate()
            .all(|(index, byte)| match index {
                4 | 7 => *byte == b'-',
                10 => *byte == b'T',
                13 | 16 => *byte == b':',
                _ => byte.is_ascii_digit(),
            });
    if !fixed {
        return Err(invalid(
            "Review timestamps must be ISO dates with a timezone.",
        ));
    }
    let mut zone = &bytes[19..];
    if zone.first() == Some(&b'.') {
        let digits = zone[1..].iter().take_while(|b| b.is_ascii_digit()).count();
        if !(1..=9).contains(&digits) {
            return Err(invalid(
                "Review timestamps allow one to nine fractional-second digits.",
            ));
        }
        zone = &zone[digits + 1..];
    }
    if zone != b"Z"
        && !(zone.len() == 6
            && matches!(zone[0], b'+' | b'-')
            && zone[3] == b':'
            && [1, 2, 4, 5]
                .iter()
                .all(|index| zone[*index].is_ascii_digit()))
    {
        return Err(invalid(
            "Review timestamps need Z or a numeric timezone offset.",
        ));
    }
    let date = DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid("A review timestamp is not a valid ISO date."))?;
    if date.nanosecond() >= 1_000_000_000 {
        return Err(invalid("Review timestamps cannot contain leap seconds."));
    }
    Ok(())
}

#[derive(Default)]
struct ThreadState {
    resolved: bool,
}
struct MessageState<'a> {
    thread_id: &'a str,
    deleted: bool,
}

pub(crate) fn validate(review: &ReviewData) -> Result<(), StoreError> {
    if review.version != 1 || review.events.len() > MAX_EVENTS {
        return Err(invalid(
            "Review history must use version 1 and contain at most 10,000 events.",
        ));
    }
    let mut budget = ByteBudget {
        remaining: MAX_REVIEW_BYTES,
    };
    serde_json::to_writer(&mut budget, review)
        .map_err(|_| invalid("Review history must be at most 8 MiB."))?;
    let mut event_ids = HashSet::new();
    let mut threads: HashMap<&str, ThreadState> = HashMap::new();
    let mut messages: HashMap<&str, MessageState<'_>> = HashMap::new();
    for raw in &review.events {
        let event = object(raw, "Review event")?;
        let event_type = string(event, "type")?;
        let id = string(event, "id")?;
        let thread_id = string(event, "threadId")?;
        validate_id(id)?;
        validate_id(thread_id)?;
        if !event_ids.insert(id) {
            return Err(invalid("Review event identifiers must be unique."));
        }
        let actor = string(event, "actor")?;
        if !has_semantic_text(actor) || actor.chars().count() > 120 {
            return Err(invalid("A review actor must contain 1–120 characters."));
        }
        timestamp(string(event, "at")?)?;
        let mut allowed = vec!["type", "id", "threadId", "at", "actor"];
        match event_type {
            "thread_created" => {
                allowed.extend([
                    "chapterId",
                    "anchor",
                    "kind",
                    "messageId",
                    "body",
                    "replacement",
                ]);
                keys(event, &allowed)?;
                if threads.contains_key(thread_id) {
                    return Err(invalid("A review thread cannot be created twice."));
                }
                validate_id(string(event, "chapterId")?)?;
                validate_anchor(required(event, "anchor")?)?;
                let kind = string(event, "kind")?;
                if !["comment", "highlight", "strikethrough", "suggestion"].contains(&kind) {
                    return Err(invalid("The annotation kind is unsupported."));
                }
                validate_body(
                    required(event, "body")?,
                    matches!(kind, "comment" | "suggestion"),
                )?;
                if let Some(replacement) = event.get("replacement") {
                    if kind != "suggestion"
                        || replacement.as_str().is_none_or(|s| utf16_len(s) > 20_000)
                    {
                        return Err(invalid("Only suggestions accept replacement text, limited to 20,000 UTF-16 units."));
                    }
                }
                let message_id = string(event, "messageId")?;
                validate_id(message_id)?;
                if messages.contains_key(message_id) {
                    return Err(invalid("Review message identifiers must be unique."));
                }
                threads.insert(thread_id, ThreadState::default());
                messages.insert(
                    message_id,
                    MessageState {
                        thread_id,
                        deleted: false,
                    },
                );
            }
            "reply_added" | "message_edited" | "message_deleted" => {
                allowed.push("messageId");
                if event_type != "message_deleted" {
                    allowed.push("body");
                }
                keys(event, &allowed)?;
                if !threads.contains_key(thread_id) {
                    return Err(invalid("A review message refers to an unknown thread."));
                }
                let message_id = string(event, "messageId")?;
                validate_id(message_id)?;
                if event_type != "message_deleted" {
                    validate_body(required(event, "body")?, true)?;
                }
                if event_type == "reply_added" {
                    if messages.contains_key(message_id) {
                        return Err(invalid("Review message identifiers must be unique."));
                    }
                    messages.insert(
                        message_id,
                        MessageState {
                            thread_id,
                            deleted: false,
                        },
                    );
                } else {
                    let message = messages.get_mut(message_id).ok_or_else(|| {
                        invalid("A review edit or deletion refers to an unknown message.")
                    })?;
                    if message.thread_id != thread_id || message.deleted {
                        return Err(invalid("A review event cannot alter a deleted message or another thread's message."));
                    }
                    if event_type == "message_deleted" {
                        message.deleted = true;
                    }
                }
            }
            "thread_resolved" | "thread_reopened" | "thread_reanchored" => {
                if event_type == "thread_reanchored" {
                    allowed.extend(["chapterId", "anchor"]);
                }
                keys(event, &allowed)?;
                let thread = threads
                    .get_mut(thread_id)
                    .ok_or_else(|| invalid("A review event refers to an unknown thread."))?;
                match event_type {
                    "thread_resolved" if !thread.resolved => thread.resolved = true,
                    "thread_reopened" if thread.resolved => thread.resolved = false,
                    "thread_reanchored" => {
                        validate_id(string(event, "chapterId")?)?;
                        validate_anchor(required(event, "anchor")?)?;
                    }
                    _ => {
                        return Err(invalid(
                            "A review thread cannot repeat its existing resolution status.",
                        ))
                    }
                }
            }
            _ => return Err(invalid("The review event type is unsupported.")),
        }
    }
    Ok(())
}

pub(crate) fn validate_append_only(
    previous: Option<&ReviewData>,
    next: Option<&ReviewData>,
) -> Result<(), StoreError> {
    if let Some(previous) = previous {
        if previous.events.is_empty() && next.is_none() {
            return Ok(());
        }
        let next = next.ok_or_else(|| invalid("Existing review history cannot be removed. Preserve its events when saving or restoring a book."))?;
        if next.version != previous.version || !next.events.starts_with(&previous.events) {
            return Err(invalid(
                "Review history is append-only. Existing events cannot be changed or removed.",
            ));
        }
    }
    Ok(())
}

fn validate_anchor(raw: &Value) -> Result<(), StoreError> {
    let anchor = object(raw, "Review anchor")?;
    keys(anchor, &["start", "end", "quote", "prefix", "suffix"])?;
    let start = unsigned(required(anchor, "start")?)?;
    let end = unsigned(required(anchor, "end")?)?;
    let length = utf16_len(string(anchor, "quote")?);
    if end <= start || end - start != length as u64 || length > 20_000 {
        return Err(invalid(
            "Review anchors need a nonempty quote matching their UTF-16 range, up to 20,000 units.",
        ));
    }
    if utf16_len(string(anchor, "prefix")?) > 64 || utf16_len(string(anchor, "suffix")?) > 64 {
        return Err(invalid(
            "Review anchor context is limited to 64 UTF-16 units per side.",
        ));
    }
    Ok(())
}

#[derive(Default)]
struct BodyBudget {
    nodes: usize,
    text_bytes: usize,
    has_text: bool,
}

fn validate_body(raw: &Value, require_text: bool) -> Result<(), StoreError> {
    let mut budget = BodyBudget::default();
    validate_node(raw, 1, None, &mut budget)?;
    if raw.get("type").and_then(Value::as_str) != Some("doc") {
        return Err(invalid("A rich review body must have a doc root."));
    }
    if require_text && !budget.has_text {
        return Err(invalid(
            "Comments, suggestions, replies, and edits must contain text.",
        ));
    }
    Ok(())
}

fn validate_node(
    raw: &Value,
    depth: usize,
    parent: Option<&str>,
    budget: &mut BodyBudget,
) -> Result<(), StoreError> {
    budget.nodes += 1;
    if depth > 20 || budget.nodes > 5000 {
        return Err(invalid(
            "A rich review body exceeds its depth or node limit.",
        ));
    }
    let node = object(raw, "Rich-text node")?;
    keys(node, &["type", "text", "attrs", "marks", "content"])?;
    let kind = string(node, "type")?;
    if ![
        "doc",
        "paragraph",
        "text",
        "heading",
        "bulletList",
        "orderedList",
        "listItem",
        "blockquote",
        "codeBlock",
        "hardBreak",
        "horizontalRule",
    ]
    .contains(&kind)
    {
        return Err(invalid("A rich review body contains an unsupported node."));
    }
    if (kind == "doc") != (depth == 1) {
        return Err(invalid(
            "A rich review doc node is only allowed at the root.",
        ));
    }
    if kind == "text" {
        let text = string(node, "text")?;
        if text.is_empty() || node.contains_key("content") {
            return Err(invalid(
                "Rich-text text nodes must contain nonempty text and no child property.",
            ));
        }
        budget.text_bytes += text.len();
        budget.has_text |= has_semantic_text(text);
        if budget.text_bytes > MAX_BODY_BYTES {
            return Err(invalid("A rich review body exceeds 100 KB of text."));
        }
    } else if node.contains_key("text") {
        return Err(invalid("Only text nodes can contain a text property."));
    }
    if let Some(attrs) = node.get("attrs") {
        validate_node_attrs(kind, object(attrs, "Node attributes")?)?;
    }
    if let Some(marks) = node.get("marks") {
        let marks = marks
            .as_array()
            .ok_or_else(|| invalid("Rich-text marks must be an array."))?;
        if !matches!(kind, "text" | "hardBreak") || parent == Some("codeBlock") || marks.len() > 7 {
            return Err(invalid("Only inline text can contain marks."));
        }
        let mut used = HashSet::new();
        for mark in marks {
            validate_mark(mark)?;
            if !used.insert(mark.get("type").and_then(Value::as_str)) {
                return Err(invalid("The same rich-text mark cannot be repeated."));
            }
        }
    }
    let content = match node.get("content") {
        Some(value) => value
            .as_array()
            .ok_or_else(|| invalid("Rich-text content must be an array."))?
            .as_slice(),
        None => &[],
    };
    if matches!(kind, "text" | "hardBreak" | "horizontalRule") && !content.is_empty() {
        return Err(invalid("Rich-text leaf nodes cannot contain children."));
    }
    if matches!(
        kind,
        "doc" | "bulletList" | "orderedList" | "listItem" | "blockquote"
    ) && content.is_empty()
    {
        return Err(invalid(
            "Rich-text document, list, and quote blocks cannot be empty.",
        ));
    }
    for child in content {
        let child_kind = child
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let allowed = match kind {
            "paragraph" | "heading" => matches!(child_kind, "text" | "hardBreak"),
            "codeBlock" => child_kind == "text",
            "bulletList" | "orderedList" => child_kind == "listItem",
            "doc" | "listItem" | "blockquote" => matches!(
                child_kind,
                "paragraph"
                    | "heading"
                    | "bulletList"
                    | "orderedList"
                    | "blockquote"
                    | "codeBlock"
                    | "horizontalRule"
            ),
            _ => false,
        };
        if !allowed {
            return Err(invalid("A rich-text node is in an unsupported position."));
        }
        validate_node(child, depth + 1, Some(kind), budget)?;
    }
    if kind == "listItem"
        && content
            .first()
            .and_then(|n| n.get("type"))
            .and_then(Value::as_str)
            != Some("paragraph")
    {
        return Err(invalid("A list item must start with a paragraph."));
    }
    Ok(())
}

fn validate_node_attrs(kind: &str, attrs: &Map<String, Value>) -> Result<(), StoreError> {
    match kind {
        "heading" => {
            keys(attrs, &["level"])?;
            if let Some(level) = attrs.get("level") {
                if !(1..=3).contains(&unsigned(level)?) {
                    return Err(invalid("Heading levels must be 1, 2, or 3."));
                }
            }
        }
        "orderedList" => {
            keys(attrs, &["start"])?;
            if let Some(start) = attrs.get("start") {
                if unsigned(start)? == 0 {
                    return Err(invalid("An ordered list must start at a positive integer."));
                }
            }
        }
        "codeBlock" => {
            keys(attrs, &["language"])?;
            if let Some(language) = attrs.get("language") {
                if !language.is_null() && language.as_str().is_none_or(|s| utf16_len(s) > 80) {
                    return Err(invalid(
                        "A code block language is limited to 80 characters.",
                    ));
                }
            }
        }
        _ => keys(attrs, &[])?,
    }
    Ok(())
}

fn validate_mark(raw: &Value) -> Result<(), StoreError> {
    let mark = object(raw, "Rich-text mark")?;
    keys(mark, &["type", "attrs"])?;
    let kind = string(mark, "type")?;
    let empty = Map::new();
    let attrs = match mark.get("attrs") {
        Some(value) => object(value, "Mark attributes")?,
        None => &empty,
    };
    match kind {
        "bold" | "italic" | "underline" | "strike" | "code" => keys(attrs, &[])?,
        "highlight" => {
            keys(attrs, &["color"])?;
            if let Some(color) = attrs.get("color") {
                if !color.is_null() {
                    let color = color
                        .as_str()
                        .ok_or_else(|| invalid("Highlight colors must be hex color strings."))?;
                    if !matches!(color.len(), 4 | 5 | 7 | 9)
                        || !color.starts_with('#')
                        || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
                    {
                        return Err(invalid(
                            "Highlight colors must use #RGB, #RGBA, #RRGGBB, or #RRGGBBAA.",
                        ));
                    }
                }
            }
        }
        "link" => {
            keys(attrs, &["href", "title", "target", "rel"])?;
            let href = string(attrs, "href")?;
            if href.is_empty()
                || utf16_len(href) > 2048
                || href
                    .chars()
                    .any(|c| c.is_control() || c.is_whitespace() || c == '\u{feff}')
            {
                return Err(invalid(
                    "Review links must be nonblank URLs without whitespace or controls.",
                ));
            }
            let url =
                url::Url::parse(href).map_err(|_| invalid("A review link is not a valid URL."))?;
            if !["http", "https", "mailto"].contains(&url.scheme())
                || (url.scheme() == "mailto" && url.path().is_empty())
            {
                return Err(invalid(
                    "Review links support only http, https, and mailto.",
                ));
            }
            for (name, limit) in [("title", 240), ("rel", 120)] {
                if let Some(value) = attrs.get(name) {
                    if !value.is_null() && value.as_str().is_none_or(|s| utf16_len(s) > limit) {
                        return Err(invalid(
                            "A review link attribute is too long or has an invalid type.",
                        ));
                    }
                }
            }
            if let Some(value) = attrs.get("target") {
                if !value.is_null()
                    && !value
                        .as_str()
                        .is_some_and(|s| ["_blank", "_self", "_parent", "_top"].contains(&s))
                {
                    return Err(invalid("A review link target is unsupported."));
                }
            }
            if let Some(rel) = attrs.get("rel").and_then(Value::as_str) {
                if !rel
                    .bytes()
                    .all(|b| b.is_ascii_alphabetic() || b == b' ' || b == b'-')
                {
                    return Err(invalid(
                        "A review link relation contains unsupported characters.",
                    ));
                }
            }
        }
        _ => return Err(invalid("A rich review body contains an unsupported mark.")),
    }
    Ok(())
}

struct ByteBudget {
    remaining: usize,
}
impl Write for ByteBudget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.remaining {
            return Err(io::Error::other("Review byte limit exceeded"));
        }
        self.remaining -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn body(text: &str) -> Value {
        json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":text}]}]})
    }
    pub(crate) fn created() -> Value {
        json!({"id":"event-1","threadId":"thread-1","at":"2026-09-30T18:00:00Z","actor":"Editor","type":"thread_created","chapterId":"chapter-1","anchor":{"start":0,"end":3,"quote":"A🌊","prefix":"","suffix":" tide"},"kind":"comment","messageId":"message-1","body":body("Consider this opening.")})
    }
    pub(crate) fn review() -> ReviewData {
        ReviewData {
            version: 1,
            events: vec![created()],
        }
    }
    fn event(kind: &str, id: &str) -> Value {
        json!({"id":id,"threadId":"thread-1","at":"2026-09-30T19:00:00+01:00","actor":"Editor","type":kind})
    }

    #[test]
    fn complete_audited_conversation_and_stale_reanchoring_are_valid() {
        let mut review = review();
        let mut reply = event("reply_added", "event-2");
        reply["messageId"] = json!("message-2");
        reply["body"] = body("A reply.");
        let mut edit = event("message_edited", "event-3");
        edit["messageId"] = json!("message-2");
        edit["body"] = body("An edited reply.");
        let mut delete = event("message_deleted", "event-4");
        delete["messageId"] = json!("message-2");
        let resolve = event("thread_resolved", "event-5");
        let reopen = event("thread_reopened", "event-6");
        let mut anchor = event("thread_reanchored", "event-7");
        anchor["chapterId"] = json!("historical-chapter");
        anchor["anchor"] = review.events[0]["anchor"].clone();
        review
            .events
            .extend([reply, edit, delete, resolve, reopen, anchor]);
        validate(&review).unwrap();
        let serialized = serde_json::to_vec(&review).unwrap();
        assert_eq!(
            serde_json::from_slice::<ReviewData>(&serialized).unwrap(),
            review
        );
    }

    #[test]
    fn unsafe_rich_nodes_marks_and_links_are_rejected() {
        for body in [
            json!({"type":"doc","content":[{"type":"html","text":"<script>alert(1)</script>"}]}),
            json!({"type":"doc","content":[{"type":"paragraph","attrs":{"onclick":"alert(1)"}}]}),
            json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"javascript:alert(1)"}}]}]}]}),
            json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"https://example.com/\nattack"}}]}]}]}),
            json!({"type":"doc","content":[{"type":"heading","attrs":{"level":4},"content":[{"type":"text","text":"x"}]}]}),
        ] {
            let mut review = review();
            review.events[0]["body"] = body;
            assert_eq!(validate(&review).unwrap_err().code, "INVALID_INPUT");
        }
        for href in [
            "https://example.com/a",
            "http://example.com",
            "mailto:editor@example.com",
        ] {
            let mut review = review();
            review.events[0]["body"]["content"][0]["content"][0]["marks"] = json!([{"type":"link","attrs":{"href":href,"target":"_blank","rel":"noopener noreferrer","title":null}}]);
            validate(&review).unwrap();
        }
    }

    #[test]
    fn bad_referents_duplicate_ids_and_invalid_status_transitions_fail() {
        for bad in [
            event("thread_reopened", "event-2"),
            event("thread_resolved", "event-1"),
            json!({"type":"message_deleted","id":"event-2","threadId":"thread-1","at":"2026-09-30T19:00:00Z","actor":"Editor","messageId":"missing"}),
        ] {
            let mut review = review();
            review.events.push(bad);
            assert!(validate(&review).is_err());
        }
        let mut review = review();
        let mut deletion = event("message_deleted", "event-2");
        deletion["messageId"] = json!("message-1");
        let mut edit = event("message_edited", "event-3");
        edit["messageId"] = json!("message-1");
        edit["body"] = body("New text");
        review.events.extend([deletion, edit]);
        assert!(validate(&review).is_err());
    }

    #[test]
    fn anchors_validate_utf16_and_real_dates() {
        let mut valid = review();
        validate(&valid).unwrap();
        valid.events[0]["anchor"]["end"] = json!(2);
        assert!(validate(&valid).is_err());
        for date in [
            "2026-02-30T12:00:00Z",
            "2026-09-30T12:00:00",
            "2026-09-30T23:59:60Z",
        ] {
            let mut invalid = review();
            invalid.events[0]["at"] = json!(date);
            assert!(validate(&invalid).is_err());
        }
    }

    #[test]
    fn only_quick_annotations_allow_empty_messages() {
        let mut review = review();
        review.events[0]["body"] = json!({"type":"doc","content":[{"type":"paragraph"}]});
        assert!(validate(&review).is_err());
        for kind in ["highlight", "strikethrough"] {
            review.events[0]["kind"] = json!(kind);
            validate(&review).unwrap();
        }
    }

    #[test]
    fn rich_text_depth_node_and_byte_budgets_are_enforced() {
        let mut review = review();
        review.events[0]["body"] = body(&"x".repeat(MAX_BODY_BYTES + 1));
        assert!(validate(&review).is_err());
        review.events[0]["body"] =
            json!({"type":"doc","content":vec![json!({"type":"paragraph"}); 5000]});
        assert!(validate(&review).is_err());
        let mut nested = json!({"type":"paragraph","content":[{"type":"text","text":"x"}]});
        for _ in 0..20 {
            nested = json!({"type":"blockquote","content":[nested]});
        }
        review.events[0]["body"] = json!({"type":"doc","content":[nested]});
        assert!(validate(&review).is_err());
    }

    #[test]
    fn prefix_comparison_preserves_optional_shapes_and_rejects_omission() {
        validate_append_only(
            Some(&ReviewData {
                version: 1,
                events: vec![],
            }),
            None,
        )
        .unwrap();
        let previous = review();
        assert!(validate_append_only(Some(&previous), None).is_err());
        let mut rewritten = previous.clone();
        rewritten.events[0]["body"]["attrs"] = json!({});
        assert!(validate_append_only(Some(&previous), Some(&rewritten)).is_err());
        let mut appended = previous.clone();
        appended.events.push(event("thread_resolved", "event-2"));
        validate_append_only(Some(&previous), Some(&appended)).unwrap();
    }

    #[test]
    fn comment_limit_counts_utf8_bytes_and_accepts_exactly_one_hundred_thousand() {
        let mut review = review();
        review.events[0]["body"] = body(&"é".repeat(50_000));
        validate(&review).unwrap();
        review.events[0]["body"] = body(&"é".repeat(50_001));
        assert!(validate(&review).is_err());
    }

    #[test]
    fn aggregate_review_size_and_event_count_are_bounded() {
        let mut review = review();
        review.events = vec![Value::Null; MAX_EVENTS + 1];
        assert!(validate(&review).unwrap_err().message.contains("10,000"));
        review.events = vec![created()];
        let large_body = body(&"x".repeat(100_000));
        for index in 2..=85 {
            let mut reply = event("reply_added", &format!("event-{index}"));
            reply["messageId"] = json!(format!("message-{index}"));
            reply["body"] = large_body.clone();
            review.events.push(reply);
        }
        assert!(validate(&review).unwrap_err().message.contains("8 MiB"));
    }

    #[test]
    fn malformed_rich_structure_and_duplicate_marks_are_rejected() {
        let mut review = review();
        for invalid_body in [
            json!({"type":"doc"}),
            json!({"type":"doc","content":[{"type":"text","text":"inline root text"}]}),
            json!({"type":"doc","content":[{"type":"paragraph","marks":[]}]}),
            json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"bold"},{"type":"bold"}]}]}]}),
            json!({"type":"doc","content":[{"type":"codeBlock","content":[{"type":"text","text":"x","marks":[]}]}]}),
            json!({"type":"doc","content":[{"type":"orderedList","attrs":{"start":0},"content":[{"type":"listItem","content":[{"type":"paragraph"}]}]}]}),
        ] {
            review.events[0]["body"] = invalid_body;
            assert!(validate(&review).is_err());
        }
    }
}
