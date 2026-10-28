import { useEffect } from 'react';

// Escape closes the topmost dialog (each open dialog registers; only the latest reacts).
const stack: (() => void)[] = [];
export function useEscape(onClose: (() => void) | null) {
  useEffect(() => {
    if (!onClose) return;
    stack.push(onClose);
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && stack[stack.length - 1] === onClose) { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); const i = stack.lastIndexOf(onClose); if (i >= 0) stack.splice(i, 1); };
  }, [onClose]);
}
