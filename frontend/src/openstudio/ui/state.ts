import { create } from 'zustand';

// Whether Open Log Studio (the desktop app's local Log Studio) fills the window instead of the chat.
export const useOpenStudio = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({ open: false, setOpen: (open) => set({ open }) }));
