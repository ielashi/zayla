# Changelog

Notable changes to Zayla, newest first. Versions follow
[Semantic Versioning](https://semver.org), and each one is published as a
Docker image at `ghcr.io/ielashi/zayla`.

## [0.3.0] - 2026-11-01

### Upgrading

- **Zero retention is on for existing OpenRouter users.** Documents now go only
  to hosts that keep nothing once they have answered. A saved model that no such
  host offers stops reading until you pick another model or turn Zero retention
  off in Settings.
- **OpenRouter now needs a key to save.** To remove a key, use Clear provider.
- **Reference details are gone.** The rows they filled under Details no longer
  appear. The values are still in the Transcription, so search still finds them.
  An existing `document.yaml` still loads, and loses its `ref:` block the next
  time that Document is written.
- **Going back to an older version:** once a Provider is saved again, the user
  file gains `kind` and `zero_retention`, which older versions don't read.

### Added

- Provider is now either OpenRouter or Custom. OpenRouter comes with Zero
  retention, on by default, which you can turn off in Settings and in Setup.
- Process a Document, or process it again, from its detail panel. Reprocessing
  asks first and names the model being replaced and the one replacing it.
- A recommended model, `google/gemini-3.6-flash`, is filled in for OpenRouter in
  Setup and Settings. A saved model always wins.
- The Model field has its own list, with typing to narrow and arrow keys.

### Changed

- List models offers only OpenRouter models that can read Documents, which takes
  the list from 452 models to 110, or 73 with Zero retention on. Custom listings
  are unfiltered.
- Languages are a list you add to, remove from and reorder, instead of four fixed
  slots. A gap or a language picked twice can no longer happen.
- The interface uses plain words instead of Zayla's internal terms, for example
  Languages for Reading languages, and Separate for Unmerge.
- The interface has a tighter set of sizes, radii and icons, with Add as the one
  filled accent.
- The page's security policy no longer allows inline styles.

### Fixed

- The person card no longer sticks to the top of the page while their Documents
  scroll underneath it.
- Processing a Document again no longer erases its Transcription when the model
  returns none. It now counts as a failed attempt, in `zayla enrich` too, and the
  Document keeps its reading.

## [0.2.0] - 2026-10-29

### Changed

- Settings is split into Provider, Reading languages and Sign-in tabs, with one
  Close button in the header that stays in reach.
- The Docker image serves a minified production build, 48 KB instead of 150 KB.

### Security

- Frontend markup is escaped by default, so text a model read out of a Document
  can't run as a script in the page.

## [0.1.0] - 2026-10-29

First release.

### Added

- Install with Docker from a published image for amd64 and arm64, with a
  `compose.yaml` and a guide in the README.

[0.3.0]: https://github.com/ielashi/zayla/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ielashi/zayla/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ielashi/zayla/releases/tag/v0.1.0
