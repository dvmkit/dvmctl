/**
 * Read only the BOLT-11 human-readable amount, without authenticating the invoice.
 * The last `1` is the bech32 separator (`1` is absent from its data charset):
 * amountless `lnbc1p…` must stay unknown rather than become 0 msat, and
 * `lnbc111p…` means 11 BTC rather than 111.
 * `null` means unknown, never zero; payment callers must refuse an unbounded ask.
 */
export function bolt11AmountMsats(bolt11: string): number | null {
  const trimmed = bolt11.trim();
  const separator = trimmed.lastIndexOf("1");
  if (separator <= 0) return null;
  const match = /^ln(?:bcrt|bc|tbs|tb|sb)(\d+)([munp])?$/i.exec(trimmed.slice(0, separator));
  if (!match) return null;
  const digits = Number(match[1]);
  if (!Number.isFinite(digits)) return null;
  // The multiplier group is optional — genuinely absent for whole-BTC invoices,
  // even though the regex typings hand back a plain string.
  const multiplier = (match[2] as string | undefined)?.toLowerCase() ?? "";
  // 1 BTC = 1e11 msats; each multiplier scales the BTC amount down.
  switch (multiplier) {
    case "m":
      return digits * 1e8;
    case "u":
      return digits * 1e5;
    case "n":
      return digits * 1e2;
    case "p":
      return Math.round(digits / 10);
    default:
      return digits * 1e11;
  }
}
