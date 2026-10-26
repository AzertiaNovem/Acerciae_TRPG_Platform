// Session epoch: every login/logout/channel switch bumps it. Async loaders capture the epoch before
// awaiting and drop their result if it changed, so a response from a previous user or channel can never
// populate the stores of the current one.
let epoch = 0;
export const sessionEpoch = () => epoch;
export const bumpEpoch = () => ++epoch;
export const isStale = (e: number) => e !== epoch;
