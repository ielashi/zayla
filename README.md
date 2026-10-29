# Zayla

A tool to archive and search your documents.
It's like Google Photos but for your documents.

## Install with Docker

Zayla is published as `ghcr.io/ielashi/zayla` for amd64 and arm64.

```sh
mkdir zayla && cd zayla
curl -O https://raw.githubusercontent.com/ielashi/zayla/main/compose.yaml
mkdir library
docker compose up -d
docker compose logs zayla
```

Open `http://<your-server>:3000`. The first visit asks for the **Setup code**
printed in the logs; it makes you the Library's owner, so whoever reaches the
port before you can't. Without Compose:

```sh
docker run -d --name zayla -p 3000:3000 -v "$PWD/library:/data" ghcr.io/ielashi/zayla:latest
```

### The Library folder

Everything Zayla keeps is plain files in the folder mounted at `/data`: your
Originals, what Zayla read out of them, and the people and organizations they
involve. You can browse it, grep it and back it up without Zayla.

The image runs as uid 1000. Create the folder yourself before the first start
(Docker would otherwise create it owned by root, and Zayla couldn't write to
it). If your user isn't uid 1000, either `chown 1000:1000 library`, or keep it
yours and run the container as you, with `user: "<uid>:<gid>"` in
`compose.yaml` (`id -u` and `id -g` print them).

### Passkeys and HTTPS

You can always sign in with a password. Passkeys need two things: HTTPS (a
reverse proxy such as Caddy, Traefik or a Cloudflare tunnel in front of Zayla),
and Zayla knowing the address your browser opens:

```yaml
    environment:
      ZAYLA_URL: https://docs.example.com
```

`ZAYLA_URL` is an origin, with no path: Zayla is served at the root of its own
domain or subdomain, not under `/zayla`. Once it's set, add a passkey under
Settings.

### Versions and upgrading

| Tag | What it is |
|---|---|
| `0.1.0` | exactly that release |
| `0.1` | the latest 0.1.x |
| `latest` | the latest release |
| `edge` | every change on `main`, unreleased |

Until 1.0, a minor version (0.1 → 0.2) may change things. To upgrade:

```sh
docker compose pull && docker compose up -d
```

**Back up the Library folder before you upgrade.** It's plain files, so a copy
(`cp -a library library-backup`, or your usual backup tool) is a complete
backup. Downgrading is not supported: an older Zayla may drop what a newer one
wrote, so to go back, restore the backup you made before upgrading. The search
index under `library/derived/` is rebuilt from the files and needn't be backed
up.

## License

Zayla is licensed under the [GNU Affero General Public License v3.0](LICENSE).
