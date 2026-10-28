import type { Channel, ServerSettings } from '../../types';

// Mirrors the backend's studioAccess: the server maintainer can turn the Log Studio off; before the story ends the
// Keeper decides whether it is shown and whether players may open it; after the end it is open to every member.
export type StudioAccess = 'open' | 'disabled' | 'hidden' | 'locked';
export function studioAccess(channel: Channel | null, settings: ServerSettings | null): StudioAccess {
  if (settings?.features?.log_studio === false) return 'disabled';
  if (!channel) return 'hidden';
  if (channel.story_status === 'ended') return 'open';
  if (channel.studio_visible === false) return 'hidden';
  if (channel.my_role !== 'gm' && channel.studio_player_access === false) return 'locked';
  return 'open';
}
