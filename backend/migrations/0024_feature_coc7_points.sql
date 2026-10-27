-- COC7 point-buy mode: a server maintainer turns it on; characters then spend career and hobby skill points
-- within the limits of a career from the built-in list.
ALTER TABLE server_settings ADD COLUMN feature_coc7_points BOOLEAN NOT NULL DEFAULT false;
