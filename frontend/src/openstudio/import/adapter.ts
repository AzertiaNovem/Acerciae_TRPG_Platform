import type { ParsedLog } from '../types';

// An external format. detect() must be cheap; parse() never drops a message: material it does not understand is
// kept as an `unrecognised` event (with its raw text) and reported in `issues`. `file` is written into every
// event's source.file and every issue.
export interface LogAdapter {
  name: ParsedLog['adapter'];
  supportedVersions: string;
  detect(text: string): boolean;
  parse(text: string, file?: string): ParsedLog;
}
