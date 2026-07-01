# Runbook: rotate ENCRYPTION_KEY

**When to use:**

- The `ENCRYPTION_KEY` is suspected leaked (committed by mistake, exposed in logs, ex-collaborator had access).
- Scheduled annual rotation as good practice.

This is a **destructive** operation if done wrong — every stored token in the database is encrypted with the current key. Mishandle it and you lose every workspace's Slack credentials and every user's Figma token.

## TL;DR

```
Step 1: generate a new key  →  openssl rand -hex 32
Step 2: deploy a one-shot rotation script that re-encrypts all *_token_enc
        columns with the new key
Step 3: swap ENCRYPTION_KEY env var to the new value
Step 4: redeploy
Step 5: verify
Step 6: invalidate the old key (delete from password manager / Vercel history)
```

## Detailed steps

### 0. Decide whether to rotate or burn-down

If you believe the key has been **actively used** by an attacker (e.g. you see suspicious database queries from outside Vercel's egress), the right move is:

1. Revoke all Slack bot tokens at the workspace admin level
2. Revoke all Figma OAuth grants
3. `TRUNCATE TABLE slack_installations, figma_tokens, figma_webhooks, auth_sessions`
4. Generate a new key, deploy, force every user to re-OAuth

If the key was merely _exposed_ (e.g. committed to a private repo, surfaced in a screenshot) but you have no evidence of use, rotation is appropriate.

### 1. Generate the new key

On a trusted machine:

```bash
openssl rand -hex 32
```

Store it in 1Password / your secret manager. Don't email it. Don't paste it in chat.

### 2. Write the rotation script

The wire format has no key id, so the rotation script needs both keys available simultaneously: decrypt with old, encrypt with new, UPDATE the row.

Create `scripts/rotate-key.mjs` (committed once, removed after use):

```js
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const OLD = Buffer.from(process.env.ENCRYPTION_KEY_OLD, "hex");
const NEW = Buffer.from(process.env.ENCRYPTION_KEY_NEW, "hex");

const ALGO = "aes-256-gcm";

function reEncrypt(combined) {
  const buf = Buffer.from(combined, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv(ALGO, OLD, iv);
  decipher.setAuthTag(tag);
  const plaintext = decipher.update(ct) + decipher.final("utf8");

  const newIv = randomBytes(12);
  const cipher = createCipheriv(ALGO, NEW, newIv);
  const newCt = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([newIv, newCt, cipher.getAuthTag()]).toString("base64");
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

for (const { table, cols } of [
  { table: "slack_installations", cols: ["bot_token_enc"] },
  { table: "figma_tokens", cols: ["access_token_enc", "refresh_token_enc"] },
]) {
  const { data, error } = await sb.from(table).select("id, " + cols.join(", "));
  if (error) throw error;
  for (const row of data) {
    const updates = {};
    for (const col of cols) if (row[col]) updates[col] = reEncrypt(row[col]);
    await sb.from(table).update(updates).eq("id", row.id);
    console.log(`✔ rotated ${table}/${row.id}`);
  }
}
```

### 3. Test it on a staging copy

If you don't have a staging Supabase, take a backup (Dashboard → Project Settings → Database → Backups → Create) and restore to a throwaway project. Run the script there first to confirm both columns decrypt with the new key.

### 4. Run the rotation against production

In Vercel CLI, with both vars set:

```bash
ENCRYPTION_KEY_OLD=<old> ENCRYPTION_KEY_NEW=<new> \
  SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/rotate-key.mjs
```

This is a one-shot batch. For a few hundred rows it runs in seconds; for thousands, add a `LIMIT` and a paging loop.

### 5. Swap `ENCRYPTION_KEY` in Vercel

```bash
vercel env rm ENCRYPTION_KEY production
vercel env add ENCRYPTION_KEY production
# paste the NEW value
vercel --prod
```

### 6. Verify

- `curl /api/health` → OK
- Pick one Slack workspace and trigger a `LIBRARY_PUBLISH` (re-save a config or wait for an organic publish). Confirm a message lands. If it doesn't, the post-rotation decrypt failed and you need to investigate before more events fail.

### 7. Burn the old key

- Delete from password manager
- Delete from Vercel env history (Vercel dashboard → Env Vars → audit log)
- Delete the `scripts/rotate-key.mjs` file from the repo

## Things that can go wrong

- **Script crashes halfway.** Re-run it idempotently — already-rotated rows decrypt cleanly with `NEW`, so add a `try { decrypt(x, NEW); skip } catch { rotate }` guard before the re-encrypt call.
- **You forgot to update `ENCRYPTION_KEY` in Vercel.** The next webhook tries to decrypt with the wrong key → throws. `notification_log` will show `decrypt_failed` for every config. Set the new env var and redeploy.
- **You committed the rotation script with secrets baked in.** Force-push to remove, rotate the keys, file an incident.
