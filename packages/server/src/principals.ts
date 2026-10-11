/**
 * Email domains run by consumer mail providers. A grant to `google-domain:<d>` for one of these would give
 * access to every account at that provider, so share refuses them.
 */
export const DEFAULT_CONSUMER_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "qq.com",
  "163.com",
];

/** True if `domain` is a built-in consumer domain or in `extra` (the lowercased `STORAGE_CONSUMER_DOMAINS`). */
export function isConsumerDomain(domain: string, extra: readonly string[]): boolean {
  const lower = domain.toLowerCase();
  return DEFAULT_CONSUMER_DOMAINS.includes(lower) || extra.includes(lower);
}
