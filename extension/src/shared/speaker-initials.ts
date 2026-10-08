const UNKNOWN_SPEAKER_ID = "unknown";

/** «Борис Ковалёв» → «БК». */
export function speakerInitials(name: string, speakerId?: string): string {
  if (speakerId === UNKNOWN_SPEAKER_ID) return "?";
  const letters = name
    .split(/\s+/)
    .map((word) => word.match(/\p{L}/u)?.[0])
    .filter((letter): letter is string => Boolean(letter))
    .slice(0, 2);
  return letters.length > 0 ? letters.join("").toUpperCase() : "?";
}
