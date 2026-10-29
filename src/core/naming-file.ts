/**
 * The Library's `naming.yaml`: every Person and Organization with the name it
 * is shown under and the spellings it has been seen as, every Merge the owner
 * has made with the names it chose, replaced and adopted, and the id the next
 * new name will take.
 *
 * Entity ids are stable integers, handed out once and never reused, so a
 * Merge, a Me or a bookmarked page can name one. Appearances are not here:
 * they follow from each Document's Enrichment and are worked out again when
 * the Library is opened (see entities.ts).
 *
 * Nothing but this module knows the file's shape; entities.ts owns what the
 * naming means.
 */

import type { EntityKind } from "./appearances.ts";
import { namingPath } from "./library.ts";
import { readYamlFileSync, writeYamlFileSync } from "./yaml.ts";

/** One Person or Organization: how it is shown, and every spelling it answers to. */
export type EntityRecord = {
  id: number;
  kind: EntityKind;
  displayName: string;
  /** In the order the Library learned them. */
  variants: string[];
};

/**
 * One Merge: `absorbedId` answers to `survivorId`, the entity named at the
 * time rather than the one answering for the group now. The names are null
 * when the owner chose none (see ADR 0002).
 */
export type MergeRecord = {
  absorbedId: number;
  survivorId: number;
  chosenName: string | null;
  replacedName: string | null;
  adoptedName: string | null;
};

/** What `naming.yaml` holds, as entities.ts works with it. */
export type NamingRecord = {
  nextId: number;
  /** By id. */
  entities: Map<number, EntityRecord>;
  /** In the order they were made. */
  merges: MergeRecord[];
};

type EntityFile = { id: number; name: string; variants: string[] };

type MergeFile = {
  absorbed: number;
  survivor: number;
  chosen_name?: string | null;
  replaced_name?: string | null;
  adopted_name?: string | null;
};

type NamingFile = {
  next_id: number;
  people: EntityFile[];
  organizations: EntityFile[];
  merges: MergeFile[];
};

const DEFAULTS: NamingFile = {
  next_id: 1,
  people: [],
  organizations: [],
  merges: [],
};

/** The naming of the Library at `root`; empty when it has learned no name yet. */
export function readNamingFile(root: string): NamingRecord {
  const file = readYamlFileSync(namingPath(root), DEFAULTS) ?? DEFAULTS;
  const entities = new Map<number, EntityRecord>();
  const add = (kind: EntityKind, list: EntityFile[] | null) => {
    for (const e of list ?? [])
      entities.set(e.id, {
        id: e.id,
        kind,
        displayName: String(e.name),
        variants: (e.variants ?? []).map(String),
      });
  };
  add("person", file.people);
  add("organization", file.organizations);
  const highest = Math.max(0, ...entities.keys());
  return {
    // Never below an id already taken, whatever the file says.
    nextId: Math.max(file.next_id ?? 1, highest + 1),
    entities,
    merges: (file.merges ?? []).map((m) => ({
      absorbedId: m.absorbed,
      survivorId: m.survivor,
      chosenName: m.chosen_name ?? null,
      replacedName: m.replaced_name ?? null,
      adoptedName: m.adopted_name ?? null,
    })),
  };
}

/** Write the whole of the Library's naming, whole or not at all. */
export function writeNamingFile(root: string, naming: NamingRecord): void {
  const sorted = [...naming.entities.values()].sort((a, b) => a.id - b.id);
  const of = (kind: EntityKind): EntityFile[] =>
    sorted
      .filter((e) => e.kind === kind)
      .map((e) => ({ id: e.id, name: e.displayName, variants: e.variants }));
  const file: NamingFile = {
    next_id: naming.nextId,
    people: of("person"),
    organizations: of("organization"),
    merges: naming.merges.map((m) => {
      const out: MergeFile = { absorbed: m.absorbedId, survivor: m.survivorId };
      // A Merge that chose no name says so by leaving the names out.
      if (m.chosenName !== null) out.chosen_name = m.chosenName;
      if (m.replacedName !== null) out.replaced_name = m.replacedName;
      if (m.adoptedName !== null) out.adopted_name = m.adoptedName;
      return out;
    }),
  };
  writeYamlFileSync(namingPath(root), file);
}
