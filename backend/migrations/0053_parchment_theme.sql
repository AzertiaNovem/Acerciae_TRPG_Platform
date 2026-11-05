-- Extend the account preference without changing any existing theme selection.
ALTER TABLE users DROP CONSTRAINT users_ui_theme_check;
ALTER TABLE users ADD CONSTRAINT users_ui_theme_check
    CHECK (ui_theme IN ('classic', 'glass', 'parchment'));
