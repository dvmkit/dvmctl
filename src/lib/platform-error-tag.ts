const platformErrors = new WeakSet<Error>();

export function markPlatformError<T extends Error>(error: T): T {
  platformErrors.add(error);
  return error;
}

export function isPlatformError(error: unknown): boolean {
  return error instanceof Error && platformErrors.has(error);
}
