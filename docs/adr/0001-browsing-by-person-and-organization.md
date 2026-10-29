# Browsing is by Person and Organization, alongside search

The Library gains a second way in: a browsable list of the People and
Organizations its Documents involve, each with a count and a page of its own.
Search stays exactly as it is, matching the same fields over the whole Library,
and the two sit side by side — search for the Document you can name, browsing for
the question you cannot phrase as a query.

Browsing is by Person and Organization because those are the only facets a
personal archive actually clusters on. A letter is from someone and to someone;
that is the fact every Document in this Library carries. It is also the only
facet that answers questions a query cannot: "everything this authority sent me"
and "everything addressed to me" are different questions that the same words
answer identically, because a query cannot distinguish the role a name played.
And a count per entity is a fact about the whole collection — that one insurer
accounts for six Documents — that no single result list can show.

## Considered Options

**Browsing by type** was tried and removed. The model's `docType` took 37
distinct values across 44 Documents — `letter` (4), `invoice` (3), then 33
singletons, including `Power of attorney` and `power of attorney` as two values.
A label that almost never repeats cannot group anything, and `category` before it
failed the same way. Two classification fields have now been dropped for this
reason; a third attempt would need new evidence, not a new name.

**Browsing by keyword** was rejected for the opposite reason. Keywords do carry
real retrieval value — the Document's own original-language terms and official
abbreviations, `Mietvertrag`, `Quellensteuer`, `BVG` — which is why they feed the
search haystack. But they were once displayed as pills with nothing behind them
and read as a feature they were not. They are a search index, not a navigable
dimension, and promoting them to one would ask the model's free text to behave
like a controlled vocabulary, which is what `docType` proved it will not do.

**Folders** were never on the table: a Document's identity is its content, so a
Document has no one place to live, and filing one by hand is the work Zayla
exists to avoid.

**Leaving search as the only way in** was the status quo. It fails on the archive's
central fact: the same Person is written several ways — "Jane Doe", "Doe Jane
Elizabeth", "Jane" — so any one spelling returns a fraction of that Person's
Documents and gives no sign the rest exist. No improvement to matching fixes
that, because the owner cannot search for a spelling they have not thought of.

## Consequences

Entities become something the Library holds, resolved when a Document is enriched
rather than derived at read time, and the owner — never Zayla on its own —
Merges the spellings that turn out to be one name. That is a real addition to the
domain, and the cost of this decision.

Navigation and addressing had to come first: with more than one way in, the
application needs a sidebar and real paths before any entity page can exist.

The comment at the top of `src/search.ts` asserted that search was the only way
into the Library. It points here instead, so that the absence of type, keyword
and folder browsing still reads as a decision rather than as an oversight.
