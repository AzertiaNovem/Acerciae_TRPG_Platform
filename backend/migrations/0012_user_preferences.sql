ALTER TABLE users ADD COLUMN ui_language text NOT NULL DEFAULT 'en'
  CHECK (ui_language IN ('en','zh-CN','zh-TW','ja','ko','es','fr','de','ru','pt','it'));
ALTER TABLE users ADD COLUMN avatar_data text NOT NULL DEFAULT '' CHECK (octet_length(avatar_data) <= 180000);
ALTER TABLE users ADD COLUMN avatar_version integer NOT NULL DEFAULT 0;
