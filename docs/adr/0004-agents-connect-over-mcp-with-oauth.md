# Agents connect over MCP, authorized with OAuth

An agent reads the Library through an MCP endpoint served by `zayla serve` at
`/mcp`, and is let in by OAuth 2.1 with Zayla as its own authorization server:
connecting sends the user to a Zayla page where they sign in as they always do
and approve the agent, which makes a Connection. The endpoint is read-only.

The agents people actually ask — claude.ai, the desktop and phone apps, ChatGPT
— reach a remote MCP server from their vendor's cloud and accept only OAuth, so
anything else would leave out the very case this exists for: asking your
assistant to find your rental contracts.

## Considered Options

**Personal access tokens** pasted into the client as a bearer header. Far less
to build, but claude.ai and ChatGPT cannot use them.

**A local stdio server** (`zayla mcp`) reading the Library folder. Needs no
auth at all, but only reaches an agent on the machine that holds the Library.

**Writes through the agent** — Import, Merge, Re-Enrich, Delete. Delete and
Re-Enrich lose things that cannot be had back, and an agent's instructions can
come from text inside any Document it read.

## Consequences

**Zayla becomes an OAuth authorization server**, its first credential that is
not a session cookie, and needs `ZAYLA_URL` to name itself as the issuer.

**A Connection is kept in its user's file**, as
[ADR 0003](0003-the-library-is-plain-files.md) asks of every durable fact, with
its refresh tokens only as hashes so the Library folder never holds a usable
credential. Access tokens are short-lived and held only in memory: a restart
just makes each agent refresh.

**claude.ai needs Zayla on the public internet.** A Zayla reachable only on a
LAN or tailnet still serves agents running there, such as Claude Code, but not
those connecting from a vendor's cloud.
