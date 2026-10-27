-- Server maintainers may turn the Log Studio off for a whole server; the GM hides it per channel
-- (channels.studio_visible). When both are open, every channel member reaches the Studio equally.
ALTER TABLE server_settings ADD COLUMN feature_log_studio BOOLEAN NOT NULL DEFAULT true;
