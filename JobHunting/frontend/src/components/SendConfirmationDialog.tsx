import { useEffect, useRef } from "react";

interface Props {
  count: number;
  subject: string;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function SendConfirmationDialog({ count, subject, submitting, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    if (e.key === "Tab") {
      const els = ref.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
      if (!els || els.length === 0) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  return (
    <div className="backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="confirm-h" aria-describedby="confirm-d" className="dialog" onKeyDown={onKeyDown}>
        <h2 id="confirm-h">Send emails?</h2>
        <div id="confirm-d">
          <p><strong>{count}</strong> recruiter{count === 1 ? "" : "s"} selected. Rows marked <code>isSend = no</code>, rows with missing fields and duplicate addresses will be skipped.</p>
          <p>Subject template: <em>{subject}</em></p>
          <p><strong>These emails will be sent externally from your Gmail account</strong> and cannot be recalled. Messages go out one at a time with a 45–90 second pause between them.</p>
        </div>
        <div className="dialog-actions">
          <button type="button" ref={cancelRef} onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="button" className="primary" onClick={onConfirm} disabled={submitting}>
            {submitting ? "Sending…" : `Send ${count} email${count === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
