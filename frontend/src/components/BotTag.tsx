import { t as tr } from '../i18n';

// The "bot" tag after the name of one of the server's bots (an AI member set up by its maintainers): on its lines, its
// characters and in every member list.
export function BotTag() {
  return <span className="pill ai bot-tag" title={tr('An AI member of this server')}>{tr('bot')}</span>;
}
