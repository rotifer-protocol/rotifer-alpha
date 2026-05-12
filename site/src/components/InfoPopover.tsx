import { useState, useEffect, useRef } from "react";
import { Info } from "lucide-react";

/** Click-to-open info popover. Opens below-left; closes on outside click or Escape. */
export function InfoPopover({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, []);

  return (
    <div ref={ref} className="relative inline-flex items-center shrink-0">
      <button
        type="button"
        onMouseDown={e => { e.preventDefault(); setOpen(o => !o); }}
        className="text-[var(--r-text-faint)] hover:text-[var(--r-text-muted)] transition-colors leading-none"
        aria-label="Info"
      >
        <Info className="w-3 h-3" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-30 w-64 glass-card p-3 shadow-xl
          text-[11px] leading-relaxed text-[var(--r-text-muted)] normal-case font-normal
          tracking-normal whitespace-normal">
          {text}
        </div>
      )}
    </div>
  );
}
