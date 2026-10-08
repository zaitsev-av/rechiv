/** Отбрасывает технические идентификаторы и плейсхолдеры вместо имён. */
export function cleanParticipantName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/\s+/g, " ")
    .replace(/\s*(?:\((?:вы|you)\)|·\s*(?:вы|you))\s*$/i, "")
    .trim();
  if (!name || name.length > 120) return null;
  if (/^(?:local|remote|participant|unknown|аноним)$/i.test(name)) return null;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(name)) return null;
  return name;
}
