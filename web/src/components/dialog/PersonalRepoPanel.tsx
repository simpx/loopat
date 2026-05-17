import { useEffect, useState } from "react"
import {
  deletePersonalVault,
  exportPersonalCryptKey,
  getPersonalStatus,
  importPersonal,
  type PersonalStatus,
} from "@/api"

/**
 * Personal-repo deploy-key flow, rendered as a settings panel.
 *
 * UX model:
 *   - Default: user pastes deploy key into their (empty) GitHub repo, pastes
 *     the repo URL here, hits Continue. Server clones, runs git-crypt init,
 *     pushes the scaffold, hands the freshly-generated key back to us. We
 *     show that key once, force the user to acknowledge they've backed it up,
 *     and then we're done. User never touches the git-crypt CLI.
 *   - Recovery: a collapsed "I already have a git-crypt key" section. Pasting
 *     a base64 key there flips to BYOK — server clones and runs
 *     `git-crypt unlock` instead of `init`. Used for re-importing the same
 *     repo onto a new host, or when host-secrets/ is lost.
 *
 * Hard guarantee from the server: import refuses unless the repo is a
 * "clean slate" — no git-crypt config and no tracked secrets. Anything else
 * the user has to fix outside loopat (rotate + fresh repo).
 */
export function PersonalRepoPanel({ onDone }: { onDone?: () => void } = {}) {
  const [status, setStatus] = useState<PersonalStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [repoUrl, setRepoUrl] = useState("")
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [cryptKey, setCryptKey] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notClean, setNotClean] = useState(false)
  const [exposedFiles, setExposedFiles] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [copiedPub, setCopiedPub] = useState(false)
  const [backupKey, setBackupKey] = useState<string | null>(null)
  const [backupCopied, setBackupCopied] = useState(false)
  const [backupAck, setBackupAck] = useState(false)

  useEffect(() => {
    setError(null)
    setNotClean(false)
    setExposedFiles([])
    setCryptKey("")
    setRecoveryOpen(false)
    setBackupKey(null)
    setBackupAck(false)
    setLoading(true)
    getPersonalStatus()
      .then((s) => {
        setStatus(s)
        setRepoUrl(s?.personalRepo ?? "")
      })
      .finally(() => setLoading(false))
  }, [])

  const copyPub = async () => {
    if (!status?.publicKey) return
    try {
      await navigator.clipboard.writeText(status.publicKey)
      setCopiedPub(true)
      setTimeout(() => setCopiedPub(false), 1500)
    } catch {}
  }

  const copyBackup = async () => {
    if (!backupKey) return
    try {
      await navigator.clipboard.writeText(backupKey)
      setBackupCopied(true)
      setTimeout(() => setBackupCopied(false), 1500)
    } catch {}
  }

  const submit = async () => {
    if (busy) return
    setError(null)
    setNotClean(false)
    setExposedFiles([])
    setBusy(true)
    try {
      const url = repoUrl.trim() || undefined
      const key = recoveryOpen && cryptKey.trim() ? cryptKey.trim() : undefined
      const r = await importPersonal(url, key)
      if (!r.ok) {
        setError(r.error ?? "import failed")
        if (r.notClean) setNotClean(true)
        if (r.secretsExposed) setExposedFiles(r.exposedFiles ?? [])
        return
      }
      if (r.autoInitialized && r.cryptKey) {
        // Force the backup acknowledgement screen — user can't dismiss this
        // until they tick "I've saved it"
        setBackupKey(r.cryptKey)
      } else {
        // Recovery path: nothing new to reveal, just close
        const fresh = await getPersonalStatus()
        setStatus(fresh)
      }
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="text-sm text-gray-400 py-8 text-center">loading…</div>
  }
  if (!status) {
    return <div className="text-sm text-red-600">failed to load status</div>
  }

  // ── Backup screen (auto-init succeeded; force ack before closing) ──
  if (backupKey) {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-sm font-semibold text-gray-900">Back up your git-crypt key</div>
        <div className="text-xs text-gray-600 leading-relaxed">
          Loopat just initialized your repo with git-crypt. The symmetric key below
          decrypts everything under <code className="text-[11px] bg-gray-100 px-1 rounded">.loopat/secrets/</code>.
          It's already stored on this host, but <b>you should save your own copy</b> —
          if this host dies and you don't have it, all secrets are unrecoverable.
        </div>
        <div className="relative">
          <textarea
            readOnly
            value={backupKey}
            rows={4}
            className="w-full text-[11px] font-mono text-gray-800 bg-gray-50 border border-gray-200 rounded p-2 outline-none resize-none break-all"
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <button
            type="button"
            onClick={copyBackup}
            className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[11px] rounded bg-white border border-gray-300 text-gray-700 hover:bg-gray-100"
          >
            {backupCopied ? "copied" : "copy"}
          </button>
        </div>
        <div className="text-[11px] text-gray-500 leading-relaxed bg-gray-50 border border-gray-200 rounded p-2">
          <b>Suggested:</b> stash this in your password manager (1Password / Bitwarden / Apple
          Keychain). To later restore on a new host, paste this same value into the
          Recovery field on the new host's Personal repo settings.
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-700">
          <input
            type="checkbox"
            checked={backupAck}
            onChange={(e) => setBackupAck(e.target.checked)}
            className="accent-gray-900"
          />
          I've saved this key somewhere safe.
        </label>
        <button
          type="button"
          onClick={() => {
            if (!backupAck) return
            setBackupKey(null)
            if (onDone) onDone()
          }}
          disabled={!backupAck}
          className="self-end px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40"
        >
          Done
        </button>
      </div>
    )
  }

  if (status.imported) {
    return <ImportedPanel status={status} />
  }

  if (!status.publicKey) {
    return (
      <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-2 leading-relaxed">
        No deploy key available — the server is probably missing{" "}
        <code className="text-[11px] bg-white px-1 rounded">openssh-client</code>.
        Install it and reopen this panel.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-gray-600 leading-relaxed">
        Two steps:
        <ol className="list-decimal pl-5 mt-1 space-y-0.5 text-gray-600">
          <li>
            Create a <b>fresh, empty</b> private GitHub repo (no README, no
            <code className="text-[11px] bg-gray-100 px-1 rounded">.loopat/</code>).
          </li>
          <li>
            Paste the public key below into that repo's{" "}
            <i>Settings → Deploy keys → Add deploy key</i>, check{" "}
            <b>Allow write access</b>, then put the repo URL here and Continue.
          </li>
        </ol>
        <div className="mt-2 text-[11px] text-gray-500">
          Loopat will run <code className="bg-gray-100 px-1 rounded">git-crypt init</code>{" "}
          inside your repo for you and push the encrypted scaffold. You don't need
          git-crypt installed locally.
        </div>
      </div>

      <div className="relative">
        <textarea
          readOnly
          value={status.publicKey}
          rows={3}
          className="w-full text-[11px] font-mono text-gray-800 bg-gray-50 border border-gray-200 rounded p-2 outline-none resize-none"
          onClick={(e) => (e.target as HTMLTextAreaElement).select()}
        />
        <button
          type="button"
          onClick={copyPub}
          className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[11px] rounded bg-white border border-gray-300 text-gray-700 hover:bg-gray-100"
        >
          {copiedPub ? "copied" : "copy"}
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-gray-700 font-medium">Repo URL</span>
        <input
          type="text"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="git@github.com:you/loopat-personal.git"
          className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
        />
      </label>

      {/* Recovery (BYOK) — collapsed by default */}
      <div className="border border-gray-200 rounded">
        <button
          type="button"
          onClick={() => setRecoveryOpen((v) => !v)}
          className="w-full flex justify-between items-center px-2.5 py-1.5 text-[11px] text-gray-600 hover:bg-gray-50"
        >
          <span>Recovery: I already have a git-crypt key for this repo</span>
          <span className="text-gray-400">{recoveryOpen ? "▾" : "▸"}</span>
        </button>
        {recoveryOpen && (
          <div className="px-2.5 pb-2.5 text-[11px] text-gray-600 leading-relaxed border-t border-gray-200">
            <p className="mt-2">
              Use this if you're re-importing an existing loopat repo onto a new
              host (or this host lost its host-secrets). The repo must already
              have git-crypt configured.
            </p>
            <textarea
              value={cryptKey}
              onChange={(e) => setCryptKey(e.target.value)}
              rows={3}
              placeholder="base64 git-crypt key"
              className="mt-2 w-full px-2 py-1.5 text-[11px] font-mono border border-gray-300 rounded outline-none focus:border-gray-500 resize-none"
            />
            <p className="mt-1 text-gray-500">
              Paste the value you saved from "Back up your git-crypt key" on
              another host (or the base64 of{" "}
              <code className="bg-gray-100 px-1 rounded">git-crypt export-key</code>{" "}
              if you originally set the repo up by hand).
            </p>
          </div>
        )}
      </div>

      {exposedFiles.length > 0 && (
        <div className="text-xs bg-red-50 border border-red-300 rounded p-2.5 leading-relaxed">
          <div className="font-semibold text-red-700 mb-1">
            ⚠️ Your secrets are exposed
          </div>
          <div className="text-red-700 mb-1.5">
            The following files appear in git as <b>plaintext</b>. Anyone with repo
            access can already read them:
          </div>
          <ul className="font-mono text-[10.5px] text-red-800 bg-white/60 rounded p-1.5 max-h-24 overflow-auto">
            {exposedFiles.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <ol className="list-decimal pl-4 text-red-700 space-y-0.5 mt-2">
            <li>
              <b>Rotate</b> the leaked secrets immediately — the old ones are burned.
            </li>
            <li>Create a fresh empty repo and point loopat there instead.</li>
          </ol>
        </div>
      )}

      {notClean && exposedFiles.length === 0 && (
        <div className="text-xs bg-amber-50 border border-amber-300 rounded p-2.5 leading-relaxed text-amber-800">
          <div className="font-semibold mb-0.5">This repo isn't a clean slate</div>
          <div>{error}</div>
          <div className="mt-1.5 text-amber-700">
            Two options: point at a fresh empty repo, or — if it's your own
            previous loopat repo — expand <i>Recovery</i> above and paste the
            crypt key.
          </div>
        </div>
      )}

      {error && !notClean && exposedFiles.length === 0 && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {error}
        </div>
      )}

      <div className="flex gap-2 mt-1">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !repoUrl.trim()}
          className="flex-1 px-3 h-9 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {busy
            ? recoveryOpen && cryptKey.trim()
              ? "unlocking…"
              : "initializing…"
            : "Continue"}
        </button>
      </div>
    </div>
  )
}

/**
 * Imported state — summary + two destructive-ish actions, both gated behind
 * a password re-prompt (session cookie alone is not enough):
 *
 *   - "Show / export git-crypt key" — reveals the key for off-host backup
 *     or for the Recovery flow on another host.
 *   - "Delete personal vault" — wipes personal/<user>/ and host-secrets/
 *     git-crypt.key. Tries to sync to remote first; if sync fails, requires
 *     three independent acknowledgements that data will be lost.
 */
function ImportedPanel({ status }: { status: PersonalStatus }) {
  type Action = null | "export" | "delete"
  const [action, setAction] = useState<Action>(null)

  return (
    <div className="flex flex-col gap-3">
      <div className="text-sm text-gray-700">
        Imported{" "}
        <code className="text-[11px] bg-gray-100 px-1 py-0.5 rounded">
          {status.personalRepo ?? "(unknown remote)"}
        </code>
        .
      </div>
      <div className="text-[11px] text-gray-400 leading-relaxed">
        To re-import, delete the vault below (loopat will sync first) and start
        a fresh import.
      </div>

      {action === "export" ? (
        <ExportKeyFlow onDone={() => setAction(null)} />
      ) : action === "delete" ? (
        <DeleteVaultFlow status={status} onDone={() => setAction(null)} />
      ) : (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setAction("export")}
            className="w-full text-left px-2.5 py-1.5 text-[11px] text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
          >
            Show / export git-crypt key (requires password)
          </button>
          <button
            type="button"
            onClick={() => setAction("delete")}
            className="w-full text-left px-2.5 py-1.5 text-[11px] text-red-700 border border-red-200 rounded hover:bg-red-50"
          >
            Delete personal vault (requires password)
          </button>
        </div>
      )}
    </div>
  )
}

function ExportKeyFlow({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cryptKey, setCryptKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const submit = async () => {
    if (busy || !password) return
    setError(null)
    setBusy(true)
    try {
      const r = await exportPersonalCryptKey(password)
      if (!r.ok) setError(r.error)
      else setCryptKey(r.cryptKey)
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!cryptKey) return
    try {
      await navigator.clipboard.writeText(cryptKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  if (cryptKey) {
    return (
      <div className="flex flex-col gap-2 border border-gray-200 rounded p-2.5">
        <div className="text-xs font-semibold text-gray-900">git-crypt key</div>
        <div className="relative">
          <textarea
            readOnly
            value={cryptKey}
            rows={4}
            className="w-full text-[11px] font-mono text-gray-800 bg-gray-50 border border-gray-200 rounded p-2 outline-none resize-none break-all"
            onClick={(e) => (e.target as HTMLTextAreaElement).select()}
          />
          <button
            type="button"
            onClick={copy}
            className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[11px] rounded bg-white border border-gray-300 text-gray-700 hover:bg-gray-100"
          >
            {copied ? "copied" : "copy"}
          </button>
        </div>
        <div className="text-[11px] text-gray-500 leading-relaxed">
          Treat it like a password — anyone with this key can decrypt everything
          under <code className="bg-gray-100 px-1 rounded">.loopat/secrets/</code>.
        </div>
        <button
          type="button"
          onClick={onDone}
          className="self-end px-3 h-8 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 border border-gray-200 rounded p-2.5">
      <div className="text-xs font-semibold text-gray-900">
        Confirm password to reveal the key
      </div>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit()
        }}
        autoFocus
        autoComplete="current-password"
        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
      />
      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy || !password}
          className="flex-1 px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {busy ? "verifying…" : "Reveal"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="px-3 h-8 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

type DataLossState = {
  syncError: string
  uncommitted?: number
  unpushed?: number
  hasRemote?: boolean
}

function DeleteVaultFlow({
  status,
  onDone,
}: {
  status: PersonalStatus
  onDone: () => void
}) {
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dataLoss, setDataLoss] = useState<DataLossState | null>(null)
  const [ack1, setAck1] = useState(false)
  const [ack2, setAck2] = useState(false)
  const [ack3, setAck3] = useState(false)
  const [done, setDone] = useState<{ synced: boolean; dataLost: boolean } | null>(null)

  const reload = () => {
    // Refresh top-level state by closing this flow; parent will re-fetch
    // /api/personal/status when the panel remounts.
    onDone()
    setTimeout(() => window.location.reload(), 50)
  }

  const submit = async (force: boolean) => {
    if (busy || !password) return
    setError(null)
    setBusy(true)
    try {
      const r = await deletePersonalVault(password, force)
      if (r.ok) {
        setDone({ synced: r.synced, dataLost: r.dataLost })
        return
      }
      if (r.wrongPassword) {
        setError(r.error)
        return
      }
      if (r.syncFailed) {
        setDataLoss({
          syncError: r.syncError ?? r.error,
          uncommitted: r.uncommitted,
          unpushed: r.unpushed,
          hasRemote: r.hasRemote,
        })
        return
      }
      setError(r.error)
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-2 border border-gray-200 rounded p-2.5">
        <div className="text-sm font-semibold text-gray-900">Vault deleted</div>
        <div className="text-xs text-gray-600 leading-relaxed">
          {done.dataLost ? (
            <span className="text-red-700">
              Unsynced changes were discarded. The vault is gone.
            </span>
          ) : done.synced ? (
            "Synced to remote and deleted. You can re-import any time."
          ) : (
            "Vault deleted. You can re-import any time."
          )}
        </div>
        <button
          type="button"
          onClick={reload}
          className="self-end px-3 h-8 text-sm rounded bg-gray-900 text-white hover:bg-gray-700"
        >
          Done
        </button>
      </div>
    )
  }

  if (dataLoss) {
    const allAcked = ack1 && ack2 && ack3
    return (
      <div className="flex flex-col gap-2 border border-red-300 bg-red-50 rounded p-2.5">
        <div className="text-sm font-semibold text-red-800">
          ⚠️ Sync failed — data will be lost
        </div>
        <div className="text-xs text-red-800 leading-relaxed">
          Loopat couldn't push your local changes to the remote.
          {(dataLoss.uncommitted ?? 0) > 0 && (
            <span> {dataLoss.uncommitted} uncommitted file(s).</span>
          )}
          {(dataLoss.unpushed ?? 0) > 0 && (
            <span> {dataLoss.unpushed} unpushed commit(s).</span>
          )}
          {dataLoss.hasRemote === false && (
            <span> No remote is configured on this vault.</span>
          )}
        </div>
        <pre className="text-[10.5px] text-red-900 bg-white/60 border border-red-200 rounded p-1.5 overflow-auto max-h-24">
          {dataLoss.syncError}
        </pre>
        <div className="text-xs text-red-800 leading-relaxed">
          Continuing now will permanently delete the unsynced changes from this
          host. To keep them, cancel and resolve the sync issue first (network,
          deploy-key write access, branch protection).
        </div>
        <div className="flex flex-col gap-1 mt-1 text-xs text-red-900">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={ack1}
              onChange={(e) => setAck1(e.target.checked)}
              className="mt-0.5 accent-red-700"
            />
            <span>I understand the unsynced changes will be deleted.</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={ack2}
              onChange={(e) => setAck2(e.target.checked)}
              className="mt-0.5 accent-red-700"
            />
            <span>I cannot recover them from this host afterwards.</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={ack3}
              onChange={(e) => setAck3(e.target.checked)}
              className="mt-0.5 accent-red-700"
            />
            <span>I still want to delete the vault now.</span>
          </label>
        </div>
        {error && (
          <div className="text-xs text-red-700 bg-white border border-red-200 rounded px-2 py-1.5">
            {error}
          </div>
        )}
        <div className="flex gap-2 mt-1">
          <button
            type="button"
            onClick={() => submit(true)}
            disabled={busy || !allAcked}
            className="flex-1 px-3 h-8 text-sm rounded bg-red-700 text-white hover:bg-red-800 disabled:opacity-40"
          >
            {busy ? "deleting…" : "Delete anyway"}
          </button>
          <button
            type="button"
            onClick={onDone}
            disabled={busy}
            className="px-3 h-8 text-sm rounded border border-red-300 text-red-700 bg-white hover:bg-red-50"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 border border-red-200 rounded p-2.5">
      <div className="text-xs font-semibold text-red-800">
        Delete personal vault
      </div>
      <div className="text-[11px] text-gray-600 leading-relaxed">
        Removes <code className="bg-gray-100 px-1 rounded">personal/{status.userId}/</code>{" "}
        on this host and forgets the git-crypt key. Loopat will try to push any
        unsynced changes to{" "}
        <code className="bg-gray-100 px-1 rounded">{status.personalRepo ?? "remote"}</code>{" "}
        first. Your GitHub repo itself is not touched.
      </div>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit(false)
        }}
        placeholder="confirm password"
        autoFocus
        autoComplete="current-password"
        className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded outline-none focus:border-gray-500"
      />
      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {error}
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => submit(false)}
          disabled={busy || !password}
          className="flex-1 px-3 h-8 text-sm rounded bg-red-700 text-white hover:bg-red-800 disabled:opacity-50"
        >
          {busy ? "working…" : "Sync & delete"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="px-3 h-8 text-sm rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
