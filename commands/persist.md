---
description: Tag the current session so `csm` can find and resume it later
argument-hint: [tag] [more-tags...]
allowed-tools: Bash(csm:*)
---

Run this exact command, substituting the arguments the user gave:

```bash
csm tag $ARGUMENTS
```

Then report its output to the user in one short line. Do not do anything else.
If the command reports that no session could be identified, tell the user to run
`csm doctor`.
