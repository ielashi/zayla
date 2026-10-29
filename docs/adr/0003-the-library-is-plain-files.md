# The Library is plain files

A Library is a folder that can be read, diffed, grepped, copied and backed up
with ordinary tools, without Zayla. Every durable fact lives in a readable
file under the Library root, and nothing Zayla keeps in a database is held
anywhere only there. SQLite remains for one job — the search index — and there
it is a Derived artifact: deleted freely, rebuilt from the files, never migrated
and never backed up.

| What | Where |
|---|---|
| Original | `objects/<hash>.<ext>` |
| What the Library knows about a Document: catalog fields, Enrichment, provenance | `about/<hash>/document.yaml` |
| Transcription | `about/<hash>/transcription.txt` |
| Persons, Organizations, Name variants, Merges | `naming.yaml` |
| A user: credentials, sessions, Me, Provider, Reading languages | `users/<id>.yaml` |
| Search index | `derived/search.db` (FTS5, disposable) |

Before this, `library.db` was the authority for everything but the Originals
and Transcriptions. It could only be understood through Zayla, every change
to its shape was another step on a migration ladder that only grew, and
deploying meant copying it aside first in case a migration went wrong.

## Considered Options

**Keeping SQLite for auth and Providers** and moving only the archive's facts.
It keeps every cost of the database — the binary file, the migrations, the
backup before deploy — for the smallest part of the data, and adds a second
storage model beside the first.

**Searching by scanning in memory**, with no index at all. It is the simplest
thing and fast enough, but at ten thousand Documents it holds the whole of every
Transcription in memory for the life of the server.

**An index format of our own on disk**, so that only the parts a query touches
are read. That is exactly what FTS5 is, and writing one means owning a file
format, compaction and torn writes, which is more than everything removing the
database saves. Using SQLite as a cache does not bring back what was wrong with
it as the authority.

**JSON**, which Bun reads and writes with nothing added. It is stricter, but
these files are meant to be read by people, and a quoted, escaped paragraph is
the opposite of that. YAML through the `yaml` package writes prose unquoted and
multi-line text as an indented block; Bun's own YAML writer quotes ordinary
prose and escapes line breaks, and TOML's writers do the same. Long lines are
written whole rather than wrapped, so that changing one word changes one line of
a diff.

## Consequences

**`document.yaml` is the commit point.** Without transactions, a Document is in
the Library exactly when that file exists. Importing writes it last, after the
Original; Deleting removes it first, before everything else. An Original with no
`document.yaml` is debris from an interrupted Import and is ignored, and a
reading that arrives after its Document was Deleted writes nothing and teaches
the Library no names, because it finds no `document.yaml` to write beside.

**Files first, memory after.** The open Library holds what the files say in
memory. Every change works out the new state, writes its file whole (written
beside, flushed to disk and renamed into place), and only then takes it into
memory, so a write that fails leaves the Library as it was. A file that is empty
or not YAML is never read as a record of defaults: one Document's unreadable
`document.yaml` leaves that Document out with a warning, and an unreadable
`naming.yaml` or user file stops the Library opening, naming the file, rather
than losing the naming or locking its owner out.

**Appearances are derived, not stored.** They are held only in memory. They
follow from each Document's Enrichment and the Name variants, so they are
worked out when the Library is opened, again for a Document when it is
re-Enriched, and again for every Document when taking back a Merge forgets a
spelling it taught — which leaves them as the next opening would. An improvement to how parties are read into Appearances therefore
applies to every Document already Enriched, without reading any of them again —
and a rule that turns up a spelling never seen before teaches it as a Name
variant at that point.

**Who answers for whom, and the counts, are held in memory.** The walk over the
Merges that [ADR 0002](0002-a-merge-is-recorded-as-a-statement-about-naming.md)
describes runs over the naming held in memory, as read from `naming.yaml`,
rather than as a query.

**The search index is kept in step, not trusted.** Each entry carries a
fingerprint of what it was built from. When the Library's writer opens it, an
index missing or of another version is rebuilt whole, and an entry whose
fingerprint no longer matches its Document — a crash between the two writes, a
Library restored beside a newer `derived/` — is built again. A process that
only reads never touches the file the server has open: it searches a private
copy in memory, brought in step the same way.

**One writer at a time.** SQLite let the CLI and the server write side by side.
Files do not, so a lock file marks the process that writes: commands that change
the Library refuse while the server runs, and those that only read keep working.
A lock whose process is gone is taken over under a guard the operating system
holds and lets go of should the process die, so of two processes finding the
same stale lock only one ever takes it.

**No migration ladder.** Fields are only ever added and a reader supplies the
default for one that is missing. A change that cannot be made that way is a
one-off rewrite of the files, written for that change and then deleted.

**Opening the Library reads every `document.yaml`.** That is the price of having
no authority but the files, and at ten thousand Documents it is a second or two.
