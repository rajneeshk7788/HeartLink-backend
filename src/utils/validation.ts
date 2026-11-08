export const isSafeHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Postgres unique-constraint violation */
export const isUniqueViolation = (err: any, constraint?: string): boolean =>
  err?.code === '23505' && (!constraint || err?.constraint === constraint);
