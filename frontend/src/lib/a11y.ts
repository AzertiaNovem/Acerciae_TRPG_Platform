import type { KeyboardEvent } from 'react';

// Props that make a clickable non-button element reachable and usable from the keyboard.
export function activate(fn: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;   // keys on a nested button belong to that button
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    },
  };
}
