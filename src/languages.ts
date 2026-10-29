/**
 * Reading languages: the languages a user wants to read their Library in.
 *
 * Dependency-free, like shared.ts, so the Settings picker and the server read
 * one list and one rule.
 */

/** Every ISO 639-1 language, by its code, uppercase as Zayla writes them. */
export const LANGUAGE_CODES: readonly string[] = `
  AA AB AE AF AK AM AN AR AS AV AY AZ BA BE BG BI BM BN BO BR BS CA CE CH CO
  CR CS CU CV CY DA DE DV DZ EE EL EN EO ES ET EU FA FF FI FJ FO FR FY GA GD
  GL GN GU GV HA HE HI HO HR HT HU HY HZ IA ID IE IG II IK IO IS IT IU JA JV
  KA KG KI KJ KK KL KM KN KO KR KS KU KV KW KY LA LB LG LI LN LO LT LU LV MG
  MH MI MK ML MN MR MS MT MY NA NB ND NE NG NL NN NO NR NV NY OC OJ OM OR OS
  PA PI PL PS PT QU RM RN RO RU RW SA SC SD SE SG SI SK SL SM SN SO SQ SR SS
  ST SU SV SW TA TE TG TH TI TK TL TN TO TR TS TT TW TY UG UK UR UZ VE VI VO
  WA WO XH YI YO ZA ZH ZU`
  .trim()
  .split(/\s+/);

/**
 * The languages the pickers offer: widely written today, so a letter in one is
 * likely. Any ISO 639-1 code is still accepted, so a language left out here
 * can be chosen through the API and is kept.
 */
export const OFFERED_LANGUAGES: readonly string[] = `
  EN DE FR ES PT IT NL PL CS SK HU RO BG EL RU UK SR HR SL SQ DA SV NO FI ET
  LV LT CA TR AR HE FA UR HI BN TA ZH JA KO VI TH ID MS SW AM`
  .trim()
  .split(/\s+/);

/**
 * The languages Zayla has been tried in, offered first. The rest are
 * offered too, without that promise.
 */
export const TESTED_LANGUAGES: readonly string[] = ["EN", "DE", "AR"];

/** How many Reading languages one user keeps. */
export const MAX_READING_LANGUAGES = 4;

/** What a user reads in until they choose: the Library's language before there was a choice. */
export const DEFAULT_READING_LANGUAGES: readonly string[] = ["EN"];

const names = new Intl.DisplayNames(["en"], { type: "language" });

/** A language's English name ("DE" → "German"); the code itself when it has none. */
export const languageName = (code: string): string =>
  names.of(code.toLowerCase()) ?? code;

/**
 * A list of Reading languages as asked for, or why it is not one: 1 to 4
 * ISO 639-1 codes, in order of preference, none twice. Codes are taken in
 * either case and kept uppercase.
 */
export function readingLanguagesFrom(
  value: unknown,
): { languages: string[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0)
    return { error: "choose at least one Reading language" };
  if (value.length > MAX_READING_LANGUAGES)
    return {
      error: `choose at most ${MAX_READING_LANGUAGES} Reading languages`,
    };
  const languages: string[] = [];
  for (const v of value) {
    const code = typeof v === "string" ? v.trim().toUpperCase() : "";
    if (!LANGUAGE_CODES.includes(code))
      return { error: `not an ISO 639-1 language: ${String(v)}` };
    if (languages.includes(code)) return { error: `${code} is chosen twice` };
    languages.push(code);
  }
  return { languages };
}
