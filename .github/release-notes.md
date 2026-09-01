## Install

```bash
npm i -g claude-sessions-cli@__VERSION__
```

### Without the npm registry

Download `claude-sessions-cli-__VERSION__.tgz` below, then:

```bash
npm i -g ./claude-sessions-cli-__VERSION__.tgz
```

### Without npm at all

csm has no dependencies and no build step, so the files are enough:

```bash
mkdir -p ~/.local/opt ~/.local/bin
tar -xzf csm-__VERSION__.tar.gz -C ~/.local/opt
ln -sf ~/.local/opt/csm-__VERSION__/bin/csm.js ~/.local/bin/csm
csm init
```

Keep the extracted directory where it is. `csm init` records its absolute path in
the Claude Code hooks, because a hook runs with a minimal environment and cannot
rely on `node` being on `PATH`, so moving the directory later stops them working.
Re-run `csm init` after upgrading this way; `csm doctor` reports it when the path
has gone stale.

Verify the downloads with `shasum -a 256 -c SHA256SUMS`.
