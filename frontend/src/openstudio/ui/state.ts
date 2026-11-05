import { create } from 'zustand';

// Whether Open Log Studio (the desktop app's local Log Studio) fills the window instead of the chat.
export const useOpenStudio = create<{ open: boolean; projectId: string | null; setOpen: (open: boolean) => void; openProject: (id: string) => void }>((set) => ({
  open: false, projectId: null, setOpen: (open) => set({ open, projectId: null }), openProject: (projectId) => set({ open: true, projectId }),
}));
