import { expect, test } from "bun:test";
import {
  type AppearanceSource,
  deriveAppearances,
  looksLikeSameName,
  normalizeName,
  splitNames,
} from "./appearances.ts";

const reading = (r: Partial<AppearanceSource> = {}): AppearanceSource => ({
  sender: null,
  receiver: null,
  people: null,
  ...r,
});

// ---- normalizeName ------------------------------------------------------

test("normalizeName: case, punctuation and whitespace don't make a second name", () => {
  expect(normalizeName("Jordan Okafor")).toBe(
    normalizeName("  jordan   OKAFOR "),
  );
  expect(normalizeName("M. Schmidt")).toBe(normalizeName("M.Schmidt"));
  expect(normalizeName("St. Gallen")).toBe(normalizeName("St Gallen"));
});

test("normalizeName: diacritics don't make a second name", () => {
  expect(normalizeName("Zürich")).toBe(normalizeName("Zurich"));
  expect(normalizeName("Ausländerbehörde")).toBe(
    normalizeName("Auslanderbehorde"),
  );
});

test("normalizeName: different names stay different", () => {
  expect(normalizeName("Jordan Okafor")).not.toBe(normalizeName("Jana Okafor"));
  expect(normalizeName("Stadt Porto")).not.toBe(normalizeName("Region Osaka"));
});

// ---- looksLikeSameName --------------------------------------------------

test("looksLikeSameName: case, punctuation, diacritics and whitespace don't make two names", () => {
  expect(
    looksLikeSameName("Zürich Versicherung", "zurich   versicherung."),
  ).toBe(true);
  expect(looksLikeSameName("M. Schmidt", "M.Schmidt")).toBe(true);
});

test("looksLikeSameName: a name written surname-first is the same name", () => {
  expect(looksLikeSameName("Okafor, Jordan", "Jordan Okafor")).toBe(true);
  expect(looksLikeSameName("Jordan Okafor", "Okafor, Jordan")).toBe(true);
});

test("looksLikeSameName: a name with a part dropped is the same name", () => {
  expect(looksLikeSameName("Jordan Elizabeth Okafor", "Jordan Okafor")).toBe(
    true,
  );
  expect(looksLikeSameName("Acme Foundation", "The Acme Foundation")).toBe(
    true,
  );
});

test("looksLikeSameName: a given name shortened to an initial is the same name", () => {
  expect(looksLikeSameName("J. Okafor", "Jordan Okafor")).toBe(true);
  expect(looksLikeSameName("Jordan Okafor", "Okafor J.")).toBe(true);
});

test("looksLikeSameName: a middle initial added is the same name, written either way round", () => {
  expect(looksLikeSameName("Anna Meier", "A. M. Meier")).toBe(true);
  expect(looksLikeSameName("A. M. Meier", "Anna Meier")).toBe(true);
  expect(looksLikeSameName("Jordan Okafor", "Okafor, J. O.")).toBe(true);
});

test("looksLikeSameName: two people sharing a surname are not the same name", () => {
  expect(looksLikeSameName("Jordan Okafor", "Jana Okafor")).toBe(false);
  expect(looksLikeSameName("M. Schmidt", "A. Schmidt")).toBe(false);
  expect(looksLikeSameName("Jordan Okafor", "Jordan Keller")).toBe(false);
});

test("looksLikeSameName: a single part is only the same name as itself", () => {
  expect(looksLikeSameName("Okafor", "Jordan Okafor")).toBe(false);
  expect(looksLikeSameName("Jordan", "Jordan Okafor")).toBe(false);
  expect(looksLikeSameName("Okafor", "okafor")).toBe(true);
});

test("looksLikeSameName: initials on their own are not the same name as a full name", () => {
  expect(looksLikeSameName("J. O.", "Jordan Okafor")).toBe(false);
});

test("looksLikeSameName: names that merely share a word are not the same name", () => {
  expect(looksLikeSameName("Stadt Porto", "Region Osaka")).toBe(false);
  // One Organization in two languages — a judgement no spelling comparison can
  // make, and the owner's to make by hand.
  expect(looksLikeSameName("Acme Foundation", "Acme Stiftung")).toBe(false);
});

test("looksLikeSameName: a name with nothing in it is nobody's name", () => {
  expect(looksLikeSameName("", "Jordan Okafor")).toBe(false);
  expect(looksLikeSameName("", "")).toBe(false);
});

// ---- splitNames ---------------------------------------------------------

test("splitNames: one name stays one name", () => {
  expect(splitNames("Stadt Porto", "organization")).toEqual(["Stadt Porto"]);
  expect(splitNames("Jordan Okafor", "person")).toEqual(["Jordan Okafor"]);
});

test("splitNames: a field crowding two signatories yields both", () => {
  expect(splitNames("M. Schmidt / A. Keller", "person")).toEqual([
    "M. Schmidt",
    "A. Keller",
  ]);
  expect(splitNames("M. Schmidt; A. Keller", "person")).toEqual([
    "M. Schmidt",
    "A. Keller",
  ]);
  expect(splitNames("M. Schmidt\nA. Keller", "person")).toEqual([
    "M. Schmidt",
    "A. Keller",
  ]);
});

test("splitNames: a conjunction parts two people but not one organization's name", () => {
  expect(splitNames("M. Schmidt and A. Keller", "person")).toEqual([
    "M. Schmidt",
    "A. Keller",
  ]);
  expect(splitNames("M. Schmidt und A. Keller", "person")).toEqual([
    "M. Schmidt",
    "A. Keller",
  ]);
  expect(splitNames("M. Schmidt & A. Keller", "person")).toEqual([
    "M. Schmidt",
    "A. Keller",
  ]);
  expect(splitNames("Schmidt and Partners", "organization")).toEqual([
    "Schmidt and Partners",
  ]);
  expect(splitNames("Müller & Partner", "organization")).toEqual([
    "Müller & Partner",
  ]);
});

test("splitNames: a comma does not split — it is how a surname comes first", () => {
  expect(splitNames("Okafor, Jordan", "person")).toEqual(["Okafor, Jordan"]);
  expect(splitNames("Acme, Inc.", "organization")).toEqual(["Acme, Inc."]);
});

test("splitNames: an absent field yields no name", () => {
  expect(splitNames("", "person")).toEqual([]);
  expect(splitNames("   ", "organization")).toEqual([]);
});

test("splitNames: a placeholder is not a name", () => {
  expect(splitNames("unknown", "organization")).toEqual([]);
  expect(splitNames("N/A", "person")).toEqual([]);
  expect(splitNames("N.N.", "person")).toEqual([]);
  expect(splitNames("—", "person")).toEqual([]);
  expect(splitNames("nicht angegeben", "organization")).toEqual([]);
  expect(splitNames("Stadt Porto / unknown", "organization")).toEqual([
    "Stadt Porto",
  ]);
});

// ---- deriveAppearances --------------------------------------------------

test("deriveAppearances: a party's organization and person each appear, the person for the organization", () => {
  const got = deriveAppearances(
    reading({
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
    }),
  );

  expect(got).toEqual([
    {
      kind: "organization",
      name: "Stadt Porto",
      role: "sender",
      affiliation: null,
    },
    {
      kind: "person",
      name: "M. Schmidt",
      role: "sender",
      affiliation: "Stadt Porto",
    },
  ]);
});

test("deriveAppearances: the receiver appears in the receiver role", () => {
  const got = deriveAppearances(
    reading({ receiver: { organization: "", person: "Jordan Okafor" } }),
  );

  expect(got).toEqual([
    {
      kind: "person",
      name: "Jordan Okafor",
      role: "receiver",
      affiliation: null,
    },
  ]);
});

test("deriveAppearances: a name the document merely names appears as mentioned", () => {
  const got = deriveAppearances(reading({ people: ["Jana Okafor"] }));

  expect(got).toEqual([
    {
      kind: "person",
      name: "Jana Okafor",
      role: "mentioned",
      affiliation: null,
    },
  ]);
});

test("deriveAppearances: a party that could not be read contributes nothing", () => {
  expect(
    deriveAppearances(
      reading({
        sender: { organization: "", person: "" },
        receiver: { organization: "unknown", person: "N/A" },
        people: [],
      }),
    ),
  ).toEqual([]);
});

test("deriveAppearances: two signatories in one field are two people, not one", () => {
  const got = deriveAppearances(
    reading({
      sender: { organization: "Stadt Porto", person: "M. Schmidt / A. Keller" },
    }),
  );

  expect(got.filter((a) => a.kind === "person")).toEqual([
    {
      kind: "person",
      name: "M. Schmidt",
      role: "sender",
      affiliation: "Stadt Porto",
    },
    {
      kind: "person",
      name: "A. Keller",
      role: "sender",
      affiliation: "Stadt Porto",
    },
  ]);
});

test("deriveAppearances: two signatories joined by 'and' are two people", () => {
  const got = deriveAppearances(
    reading({
      sender: {
        organization: "Schmidt and Partners",
        person: "M. Schmidt and A. Keller",
      },
    }),
  );

  expect(got.map((a) => [a.kind, a.name])).toEqual([
    ["organization", "Schmidt and Partners"], // the organization's own name
    ["person", "M. Schmidt"],
    ["person", "A. Keller"],
  ]);
});

test("deriveAppearances: an ambiguous pair of organizations affiliates nobody", () => {
  const got = deriveAppearances(
    reading({
      sender: { organization: "Stadt Porto; Region Osaka", person: "M. Schmidt" },
    }),
  );

  expect(got.map((a) => a.name)).toEqual([
    "Stadt Porto",
    "Region Osaka",
    "M. Schmidt",
  ]);
  expect(got.find((a) => a.kind === "person")?.affiliation).toBeNull();
});

test("deriveAppearances: a party name repeated in the people list is not also mentioned", () => {
  const got = deriveAppearances(
    reading({
      sender: { organization: "Stadt Porto", person: "M. Schmidt" },
      people: ["m. schmidt", "Jana Okafor"],
    }),
  );

  expect(got.map((a) => [a.name, a.role])).toEqual([
    ["Stadt Porto", "sender"],
    ["M. Schmidt", "sender"],
    ["Jana Okafor", "mentioned"],
  ]);
});

test("deriveAppearances: the same name twice in one party is one appearance", () => {
  const got = deriveAppearances(
    reading({
      sender: { organization: "Stadt Porto", person: "M. Schmidt; M. SCHMIDT" },
    }),
  );

  expect(got.filter((a) => a.kind === "person").length).toBe(1);
});

test("deriveAppearances: a name that sent and received one document plays both roles", () => {
  const got = deriveAppearances(
    reading({
      sender: { organization: "", person: "Jordan Okafor" },
      receiver: { organization: "", person: "Jordan Okafor" },
    }),
  );

  expect(got.map((a) => a.role)).toEqual(["sender", "receiver"]);
});

test("deriveAppearances: names keep the spelling the document used", () => {
  const got = deriveAppearances(
    reading({ sender: { organization: "  Stadt   Porto ", person: "" } }),
  );

  expect(got[0]?.name).toBe("Stadt Porto"); // tidied, not rewritten
});
