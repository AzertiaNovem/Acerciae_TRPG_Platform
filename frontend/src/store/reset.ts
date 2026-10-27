import { useNav } from './nav';
import { useChat } from './chat';
import { useDocuments } from './documents';
import { useHighlights } from './highlights';
import { useUi } from './ui';
import { useStudio } from './studio';
import { useReminders } from './reminders';

// Clears everything that belongs to a user session. Called on login, register and logout.
export function resetUserStores() {
  useNav.getState().reset();
  useChat.getState().reset();
  useDocuments.getState().reset();
  useHighlights.getState().reset();
  useUi.getState().reset();
  useStudio.getState().reset();
  useReminders.getState().reset();
}
// Clears everything that belongs to one channel's context. Called when switching channels.
export function resetChannelStores() {
  useDocuments.getState().reset();
  useHighlights.getState().reset();
  useUi.getState().reset();
  useChat.getState().clearJump();
  useStudio.getState().reset();
  useReminders.getState().reset();
}
