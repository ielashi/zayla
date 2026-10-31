# Zayla

A personal archive for the documents that arrive in your life — letters, bills,
scans, contracts. You put a file in; Zayla works out what it is so you can
find it again later.

## Language

These are the words of the code, its docs and its issues. The interface speaks
to people instead: a term appears there only if someone who has never read this
file would follow it, lowercase within a sentence, and an entry below says so
where the interface has a word of its own. A named setting, such as Zero
retention, keeps its capital.

### The archive

**Library**:
One person's whole collection: every Document they've kept, together with what
Zayla has worked out about them. Searching and sorting read what Zayla
worked out; they never open the Originals. Searching reads each Document's
Transcription along with the rest of its Enrichment, so it finds the words the
model read rather than the words on the page: a misread word, or one past where
an incomplete Transcription stops, cannot be found.
_Avoid_: Vault, archive, collection, catalog

**Document**:
A single thing that was filed — one letter, one bill, one scan. A Document's
identity is its content, so the same file added twice is one Document, and
renaming a file before adding it doesn't make a second one.
_Avoid_: File, record, item, scan

### What a Document is made of

**Original**:
The exact bytes that were filed, kept unchanged. The thing you get back when you
open a Document, and the authority on what the Document actually says.
_Avoid_: Source, blob, asset

**Derived artifact**:
Something Zayla computed from an Original, such as a thumbnail. Computing it
again from the same Original always gives the same result, so it is never the
only copy of anything and may be deleted to reclaim space at any time.
_Avoid_: Cache, preview, rendition

**Enrichment**:
What a model read out of a Document — its title, date, sender, deadlines,
keywords, summary and Transcription. Unlike a Derived artifact, an Enrichment
cannot be computed again: a different model, or the same model on a different
day, produces a different reading. The one you have was made once and is gone
if deleted, so every Enrichment records which model produced it, the address
the Document was sent to for reading, and when.
_Avoid_: Extraction, analysis, OCR, metadata

**Provider**:
The model, at an address, that a user's Documents are sent to for Enrichment.
Each user has at most one, chosen by themselves; until one is chosen, their
Documents are filed but wait to be read. Changing the Provider never re-reads
anything: Documents already Enriched keep the reading they have, and say which
model made it. A Provider is either OpenRouter, at its one fixed address, or
Custom, at any other address the user gives; OpenRouter is reached only by
choosing it, never by typing its address as a Custom one.
_Avoid_: Reader, backend, engine, LLM, settings

**Zero retention**:
An OpenRouter Provider's promise that a Document is sent only to hosts that
keep nothing of it once they have answered — no logs, no copy held for abuse
review. It is part of each user's Provider, on whenever OpenRouter is chosen
until that user turns it off. A Document that no such host will read waits
unread rather than going anywhere else. A Custom Provider has no Zero
retention to offer: where its Documents are kept is up to that server.
_Avoid_: ZDR, privacy mode, no-logging, data policy

**Reading language**:
A language a user wants to read their Library in. Each user keeps up to four,
in order of preference. A shortlist of widely written languages is offered:
some are marked as tested, and the rest are offered without that promise. When a Document is Enriched, its title
and summary are written in each of its user's reading languages. Which one is
shown is the Document's own language if it is one of them, else the first,
else whatever the Document has. Changing reading languages never re-reads
anything, and removing one discards nothing already written in it — until the
Document is next read, when its titles and summaries are replaced by those in
the reading languages of the user who asked. Keywords and the Transcription
stay in the Document's own language regardless.
The interface calls them "languages".
_Avoid_: Locale, display language, UI language, target language

**Transcription**:
What a Document said, word for word, as read back by a model. A Transcription is
an Enrichment, not a Derived artifact: it is a best-effort reading rather than a
copy, so the Original remains the authority on what the Document says. A
Transcription may be incomplete, and says so when it is.
_Avoid_: Original text, full text, extraction, OCR, transcript

### Who the Documents are about

**Person**:
One human being the Library's Documents involve — the official who signed, the
household member addressed, the doctor named inside. A Person is known by the
spellings their Documents used, so "Jane Doe" and "J. Doe" are one Person once
Zayla has been told so, and two until then.
_Avoid_: Contact, author, party, individual

**Organization**:
One institution, company or authority the Library's Documents involve, as a
whole rather than by department: the tax office, not its assessment unit. Like a
Person, it is known by the spellings its Documents used, so "Acme Foundation"
and "Acme Stiftung" are one Organization once Zayla has been told so.
_Avoid_: Company, institution, entity, issuer

**Entity**:
A Person or an Organization — the umbrella for the two, used where the kind
doesn't matter, as in a list of everyone the Library's Documents involve. Never
a substitute for either term: calling one institution "an entity" says less
than naming it an Organization, which is why Organization avoids the word.
_Avoid_: Party, contact, actor, name

**Appearance**:
One Document naming one Person or Organization, in the part that name played:
Sender, Receiver or Mentioned. An Appearance also carries the Organization a
Person acted for in that Document, because the same Person may act for someone
else in the next one. Appearances follow from a Document's Enrichment and the
Name variants, so they are worked out again whenever the Library is opened:
re-Enriching a Document replaces its Appearances rather than adding to them,
and a better way of telling who a Document involves applies to every Document
already Enriched without reading any of them again.
_Avoid_: Mention, occurrence, link, reference

**Name variant**:
One spelling a Person or Organization has been seen under. Variants are how a
name read out of a Document resolves to someone already known, and they outlive
the Documents they were learned from: deciding that two spellings are one name
is work done once.
_Avoid_: Alias, synonym, alternate name

**Merge**:
The owner's statement that two Persons, or two Organizations, are one — the
point at which eighteen Documents filed under one spelling and four under
another become one Person with twenty-two. A Merge is a statement about naming,
not about Documents: nothing is discarded, no Appearance is rewritten, and the
surviving name is chosen rather than guessed — the spelling with the most
Documents behind it unless the owner says otherwise. Zayla never Merges on
its own, and the owner can take any Merge back, which leaves both names exactly
as they stood. A Merge outlives the Documents it was made over, so untangling a
name is work done once.
The interface says two names are "the same", and taking a Merge back "separate".
_Avoid_: Dedupe, link, alias, combine

**Me**:
The Person a user has marked as themselves — which is what makes "addressed to
me" and "addressed to someone else here" two questions rather than one. Me is a
statement about a user, not a property of the Person: it is kept per user, so
each user of one Library has their own Me and marking says nothing about anyone
else's, while the Documents stay shared as they always were. Marking a different
Person replaces the mark and changes nothing about either Person. Only a Person
is ever Me, never an Organization, and each user says which Person theirs is
from that Person's own page, so a name never has to be typed in anywhere.
_Avoid_: Self, account, profile, user

### Working with the Library

**Import**:
Adding a Document to the Library. Importing content the Library already holds
changes nothing, because identity is the content.
The interface says "add".
_Avoid_: Upload, ingest, add

**Re-Enrich**:
Deliberately replacing a Document's Enrichment with a new reading, made by the
Provider of the user who asked and in their reading languages. The reading it
replaces is gone, so it is confirmed first, naming the model that made it. A
reading that fails, or that brings back no Transcription where the Document had
one, replaces nothing. The interface calls Enriching "processing", and
Re-Enriching "processing again"; those are its words for people, not other
concepts.
_Avoid_: Refresh, redo, retry, reprocess

**Delete**:
Permanently removing a Document — its place in the Library, its Original, its
Derived artifacts, its Enrichment and its Appearances, all at once. Zayla
has no trash and no undo: Delete means the Document is gone, and re-adding the
same file later produces a fresh Document with no Enrichment. A reading still
under way when a Document is Deleted is discarded when it arrives; it neither
brings the Document back nor teaches the Library any names. What survives is
the naming: a Person or Organization keeps its Name variants even once the last
Document naming it is gone.
_Avoid_: Remove, archive, trash, hide
