/**
 * The query parameters `cacheKeyFor` strips from a cache key (the reasoning is in
 * `server/cache-request.ts`). Core, because `prefillAnswers` must refuse to seed from
 * them: a prefilled render stored under a key that ignores the parameter would hand
 * one visitor's value to everyone.
 */
const CLICK_IDS = new Set([
  // Google Ads / Analytics
  "gclid",
  "gclsrc",
  "gbraid",
  "wbraid",
  "dclid",
  // Meta
  "fbclid",
  // Microsoft / Bing
  "msclkid",
  // TikTok, X, LinkedIn, Instagram, Pinterest, Yandex, Snapchat
  "ttclid",
  "twclid",
  "li_fat_id",
  "igshid",
  "epik",
  "yclid",
  "sc_cid",
  // Mailchimp
  "mc_cid",
  "mc_eid",
  // HubSpot
  "_hsenc",
  "_hsmi",
  "hsctatracking",
  // Adobe
  "s_kwcid",
]);

export function isClickId(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith("utm_") || CLICK_IDS.has(key);
}
