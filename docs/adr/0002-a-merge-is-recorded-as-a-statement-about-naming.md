# A Merge is recorded as a statement about naming

Telling Zayla that two names are one Person records a Merge — one record saying
that this entity answers to that one — and changes nothing else. The Appearances
of both names are left as they are, each still resolving to the entity whose
spelling its Document actually used (since
[ADR 0003](0003-the-library-is-plain-files.md) they are derived from each
Document's Enrichment and held in memory, not stored). Reads follow the Merges to the
entity that answers for the group: the listing shows one name with the distinct
Documents of both, counted once each.

This is what the domain already says a Merge is. A Merge is a statement about
naming, not about Documents, so the Documents are left alone. Everything the
feature promises follows from that one property rather than from extra
bookkeeping:

- **Unmerging is exact.** Nothing was moved, so there is nothing to put back
  wrongly. A Document read while the two names were one named the spelling it
  named, and goes back to it.
- **The judgement outlives the Documents.** A Merge is a record about two entities
  and survives Deleting every Document behind it, like the Name variants do, so
  a re-Imported Document resolves to the merged name without the work being
  repeated.
- **Each Merge can be taken back on its own.** A Merge records the entity named
  at the time, not the one that answers for the group now, so Merges chain
  rather than flatten and taking one back leaves the others standing. A Merge
  that named the surviving entity also records the name it replaced; taken back
  out of order, it hands that name to whichever later Merge holds the name now,
  so the oldest name is still what the last Merge taken back restores.

## Considered Options

**Rewriting the Appearances onto the surviving entity** — moving the rows and
deleting the absorbed entity — is the obvious implementation and gives the right
count with no read-time work. It was rejected because it throws away exactly
what Unmerging needs: which Documents named which spelling. Nothing short of a
full undo log recovers that, and a Document Enriched while the Merge stood could
never be given back to the name it used, because by then nothing records that it
used it.

**Moving the Name variants onto the surviving entity**, leaving the Appearances
alone, was the next candidate and is how the ticket describes the effect. It
still needs a record of what moved in order to move it back, so it does not
avoid the Merge record; and it makes a newly Enriched Document resolve straight to
the survivor, which puts that Document on the wrong name as soon as the Merge is
taken back. Recording the Merge and leaving the variants with the entity they
were learned for subsumes it.

**Deciding the surviving name by the order the owner typed** was rejected
because merging is a statement that two names are the same, which is symmetric.
The name with the most Documents behind it survives — the eighteen keep their
heading and the four join them — and `--name` is there for when the owner wants
a spelling neither entity has. That spelling is recorded as a Name variant too,
so a Document that later uses it resolves to the Person it was chosen for rather
than starting the work again.

**Deciding it by the group's Documents rather than the spelling's own** was how
this was first written, and it is wrong: the default is meant to be the most
frequent _variant_. A name with eight Documents is the more frequent of the two
even when the other has nine between the spellings already merged under it, so
it is each spelling's own Documents that decide, and the group it brings with it
follows as a chain. The effect is that a Merge never has to rename the surviving
entity to honour the default — the entity that survives already carries the most
frequent spelling — and only `--name` changes a display name at all.

## Consequences

Reading entities is no longer a plain grouping by entity: every read resolves
each entity to the one that answers for it through a walk over the Merges, and
counts, roles and affiliations are grouped by that. The walk starts from the
entities nothing was merged into, so a Merge that somehow pointed in a circle
drops those names out of the listing instead of looping. (This was first written
as a recursive query over the Merges table; since
[ADR 0003](0003-the-library-is-plain-files.md) it is a walk over the Merges held
in memory, with the same property.)

An absorbed entity keeps its id and its Appearances while no longer appearing in
any listing. Anything that addresses an entity — the entity pages that come with
browsing in the web interface — has to resolve an id through the Merges rather
than assume the id it was given still answers for itself.

The count is of the distinct Documents across a group rather than over one
entity. That is what makes a Document naming both spellings count once, and it
is the reason the count cannot be stored on the entity.
