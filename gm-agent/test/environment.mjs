// Loaded before tests and inherited by CLI children. Fixtures opt in with --env.
import { ENV_KEYS } from '../src/config.mjs';
for (const key of ENV_KEYS) delete process.env[key];
process.env.ACERCIAE_NO_DOTENV = '1';
