-- OpenAI speech (/audio/speech: gpt-4o-mini-tts or a later model with the same contract) as a server TTS provider.
ALTER TABLE server_settings DROP CONSTRAINT IF EXISTS server_settings_tts_provider_check;
ALTER TABLE server_settings ADD CONSTRAINT server_settings_tts_provider_check CHECK (tts_provider IN ('disabled', 'mock', 'qwen', 'openai'));
