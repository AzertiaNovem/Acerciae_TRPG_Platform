// Lighting is a display preference, never a statement about the story's time of day.
export function atmosphereVariant(dark: boolean, portrait: boolean) {
  return `${dark ? 'night' : 'day'}_${portrait ? 'portrait' : 'landscape'}`;
}
