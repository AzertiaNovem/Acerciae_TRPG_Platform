-- Drafts and the sheet state at the time of a ruling are private to the GM.
ALTER TABLE pbta_packs ADD COLUMN review jsonb NOT NULL DEFAULT '{"status":"none","version":0}';
CREATE TABLE pbta_rulings (
    roll_id uuid PRIMARY KEY REFERENCES messages ON DELETE CASCADE,
    intent_id uuid REFERENCES messages ON DELETE SET NULL,
    delegated boolean NOT NULL,
    card jsonb NOT NULL,
    question_id uuid REFERENCES messages ON DELETE SET NULL
);
CREATE INDEX pbta_ruling_intent ON pbta_rulings(intent_id);
CREATE TABLE pbta_marks (
    roll_id uuid NOT NULL REFERENCES pbta_rulings ON DELETE CASCADE,
    section text NOT NULL, field text NOT NULL,
    message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
    PRIMARY KEY(roll_id,section,field)
);
-- One co-player declaration per triggering line in that scene, even after a lost acknowledgement.
CREATE TABLE pbta_declarations (
    anchor_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
    character_id uuid NOT NULL REFERENCES characters ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES messages ON DELETE CASCADE,
    command jsonb NOT NULL,
    PRIMARY KEY(anchor_id,character_id)
);
