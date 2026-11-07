-- Illustrations become optional at both levels, like consistency and inspiration: the server's maintainers switch the
-- feature for the whole server, and the GM for their channel under it. Both start on, so nothing changes until someone
-- turns it off. Off refuses new drawings only: pictures already posted stay, and their lines keep serving them.
ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS feature_illustrations BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS illustrations_enabled BOOLEAN NOT NULL DEFAULT true;
