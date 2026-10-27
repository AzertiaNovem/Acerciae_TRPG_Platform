ALTER TABLE server_settings
  ADD COLUMN llm_provider text NOT NULL DEFAULT '' CHECK (llm_provider IN ('', 'openai_compatible', 'anthropic')),
  ADD COLUMN image_provider text NOT NULL DEFAULT 'inherit' CHECK (image_provider IN ('inherit', 'disabled', 'mock', 'gpt_image')),
  ADD COLUMN image_api_base text NOT NULL DEFAULT '',
  ADD COLUMN image_api_key_sealed text NOT NULL DEFAULT '',
  ADD COLUMN image_api_key_hint text NOT NULL DEFAULT '',
  ADD COLUMN image_model text NOT NULL DEFAULT '',
  ADD COLUMN image_size text NOT NULL DEFAULT 'auto',
  ADD COLUMN image_quality text NOT NULL DEFAULT 'auto';
