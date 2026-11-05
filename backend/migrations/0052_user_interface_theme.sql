ALTER TABLE users ADD COLUMN ui_theme TEXT NOT NULL DEFAULT 'classic'
    CHECK (ui_theme IN ('classic', 'glass'));
