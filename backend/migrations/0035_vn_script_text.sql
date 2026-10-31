-- The visual-novel composer may reword a line (fluent narration, short questions and answers folded into narration).
-- The log keeps its own words; script_text is the presentation's wording, NULL = the log's.
ALTER TABLE presentation_events ADD COLUMN script_text TEXT;
