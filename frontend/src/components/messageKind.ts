import { t as tr } from '../i18n';

// The label of a message's kind, as its pill shows it. An interactive message is kind 'hypertext', which no reader
// should see as such: the pill says "Interactive message".
export const kindLabel = (kind: string) => (kind === 'hypertext' ? tr('Interactive message') : tr(kind));
