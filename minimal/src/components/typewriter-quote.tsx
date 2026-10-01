import { useEffect, useState } from "react";
import { ArrowRight, Pause, Play } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { writingQuotes } from "@/lib/writing-quotes";
import "./typewriter-quote.css";

type QuoteState = { index: number; length: number; phase: "typing" | "reading" | "leaving" };

export function TypewriterQuote() {
  const reducedMotion = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [state, setState] = useState<QuoteState>({ index: 0, length: 0, phase: "typing" });
  const quote = writingQuotes[state.index];
  const characters = Array.from(quote.text);
  const complete = reducedMotion || state.length >= characters.length;

  useEffect(() => {
    const onVisibilityChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    if (reducedMotion || paused || !visible) return;
    // A single cancellable timer keeps the animation local to this component.
    const previous = characters[state.length - 1] ?? "";
    const delay = state.phase === "reading" ? 7000
      : state.phase === "leaving" ? 280
      : state.length === 0 ? 450
      : /[.!?]/.test(previous) ? 260
      : /[,;:—]/.test(previous) ? 150 : 38;
    const timer = window.setTimeout(() => {
      setState(current => {
        if (current.phase === "reading") return { ...current, phase: "leaving" };
        if (current.phase === "leaving") return { index: (current.index + 1) % writingQuotes.length, length: 0, phase: "typing" };
        const length = current.length + 1;
        return { ...current, length, phase: length >= characters.length ? "reading" : "typing" };
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [state, paused, visible, reducedMotion, characters.length, characters[state.length - 1]]);

  function nextQuote() {
    setState(current => {
      const index = (current.index + 1) % writingQuotes.length;
      return { index, length: paused || reducedMotion ? Array.from(writingQuotes[index].text).length : 0, phase: paused || reducedMotion ? "reading" : "typing" };
    });
  }

  const pauseLabel = paused ? "Resume quotes" : "Pause quotes";

  return (
    <section className="sidebar-quote" aria-label="Writing inspiration">
      <span className="quote-mark" aria-hidden="true">“</span>
      {/* Read a complete quote once, without announcing every typed character. */}
      <blockquote className="sr-only">{quote.text}<cite> — {quote.author}</cite></blockquote>
      <motion.div
        className="quote-passage"
        aria-hidden="true"
        animate={{ opacity: state.phase === "leaving" && !reducedMotion && !paused ? 0 : 1, y: state.phase === "leaving" && !reducedMotion && !paused ? -4 : 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.22 }}
      >
        <div className="quote-stage">
          {/* Reserve the tallest quote at this width so the sidebar never jumps. */}
          {writingQuotes.map(item => <p className="quote-measure" key={item.author}>{item.text}<span className="quote-caret-space" /></p>)}
          <p className="quote-typed">
            {reducedMotion ? quote.text : characters.slice(0, state.length).join("")}
            {!reducedMotion && <motion.span
              className="quote-caret"
              animate={{ opacity: paused || !visible ? 0.4 : [1, 1, 0, 0] }}
              transition={paused || !visible ? { duration: 0 } : { duration: 1.1, times: [0, 0.45, 0.5, 1], repeat: Infinity }}
            />}
          </p>
        </div>
        <motion.small className="quote-author" animate={{ opacity: complete ? 1 : 0 }} transition={{ duration: reducedMotion ? 0 : 0.35 }}>— {quote.author}</motion.small>
      </motion.div>
      <div className="quote-controls">
        <span className="quote-position" aria-hidden="true">{String(state.index + 1).padStart(2, "0")} <span>/ {String(writingQuotes.length).padStart(2, "0")}</span></span>
        {!reducedMotion && <Tooltip>
          <TooltipTrigger asChild>
            <Button className="quote-control" variant="ghost" size="icon" aria-label={pauseLabel} aria-pressed={paused} onClick={() => setPaused(value => !value)}>
              {paused ? <Play size={12} /> : <Pause size={12} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{pauseLabel}</TooltipContent>
        </Tooltip>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button className="quote-control" variant="ghost" size="icon" aria-label="Next quote" onClick={nextQuote}><ArrowRight size={14} /></Button>
          </TooltipTrigger>
          <TooltipContent>Next quote</TooltipContent>
        </Tooltip>
      </div>
    </section>
  );
}
