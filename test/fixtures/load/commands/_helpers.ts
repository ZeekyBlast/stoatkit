// Starts with "_", so the loader skips it. Command files can still import it.
export const reasonOrDefault = (reason: string | undefined) => reason ?? "No reason given";
