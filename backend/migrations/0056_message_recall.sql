-- Recall: an author takes a line back shortly after sending it. The row stays as a tombstone (same id, window and
-- seq, so every client replaces its copy by id) with its text, dice and references erased and `recalled_at` set.
-- Its events are deleted, so the AI, the scene logs and the campaign log never see the line again.
ALTER TABLE messages ADD COLUMN recalled_at TIMESTAMPTZ;
