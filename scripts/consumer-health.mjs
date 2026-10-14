// @ts-check

/** @param {number | undefined} statusCode @param {string} body */
export function isHealthyResponse(statusCode, body) {
  if (statusCode !== 200) return false;
  try {
    const value = JSON.parse(body);
    return value?.status === "ok";
  } catch {
    return false;
  }
}
