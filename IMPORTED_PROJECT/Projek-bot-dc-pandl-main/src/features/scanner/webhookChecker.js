// Checks whether a discovered Discord webhook URL is actually live.
// Discord answers a plain GET on a webhook endpoint with 200 + JSON when it
// still exists, and 404 when it has been deleted/invalidated. Any other
// outcome (timeout, network error, unexpected status) is reported honestly
// as "cannot be verified" rather than guessed.

const TIMEOUT_MS = 5000;

/**
 * @param {string} url
 * @returns {Promise<"Aktif"|"Tidak Aktif"|"Tidak dapat diperiksa">}
 */
export async function checkWebhookStatus(url) {
  if (!url) return "Tidak dapat diperiksa";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    if (response.status === 200) return "Aktif";
    if (response.status === 404) return "Tidak Aktif";
    return "Tidak dapat diperiksa";
  } catch {
    return "Tidak dapat diperiksa";
  } finally {
    clearTimeout(timer);
  }
}
