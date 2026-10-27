-- Log Studio availability: a server maintainer can switch it off for the whole server (server settings
-- features.log_studio) and the GM can hide it for one channel. When both are on, every member of the channel
-- reaches the Studio equally, within what they are allowed to read.
ALTER TABLE channels ADD COLUMN studio_visible BOOLEAN NOT NULL DEFAULT true;
