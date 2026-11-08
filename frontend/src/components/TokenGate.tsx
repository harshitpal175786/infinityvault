import { useState } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { setAccessToken } from '../api'

type TokenGateProps = {
  /** Shown when a stored token was rejected, so the copy explains the retry. */
  rejected: boolean
  /** True while a submitted token is being verified against the API. */
  checking?: boolean
  onSubmit: () => void
}

/**
 * Full-screen prompt shown when the API answers 401.
 *
 * The vault is single-owner, so there is nothing to "log in" as — the only
 * question is whether this browser holds the token. Copy says where the token
 * comes from, because a user who has never run the command has no way to guess.
 */
export function TokenGate({ rejected, checking = false, onSubmit }: TokenGateProps) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (checking) return
    const trimmed = value.trim()
    if (!trimmed) {
      setError('Paste the token that “npm run infinityvault -- token” printed.')
      return
    }
    setError(null)
    setAccessToken(trimmed)
    onSubmit()
  }

  return (
    <div className="token-gate">
      <form className="token-card" onSubmit={submit}>
        <span className="token-icon">
          {rejected ? <ShieldAlert size={22} /> : <KeyRound size={22} />}
        </span>
        <h1 className="token-title">Unlock your vault</h1>
        <p className="token-copy">
          {rejected
            ? 'That token was rejected. Paste the current one — if you rotated it, run the command again to see the new value.'
            : 'This library is private, so the API needs its access token before it will answer.'}
        </p>

        <label className="token-label" htmlFor="access-token">
          Access token
        </label>
        <input
          id="access-token"
          className="token-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste your token"
          autoFocus
        />

        {error && <p className="token-error" role="alert">{error}</p>}

        <button type="submit" className="token-submit" disabled={checking}>
          {checking ? 'Checking…' : 'Unlock'}
        </button>

        <p className="token-hint">
          Generate or rotate it with{' '}
          <code>npm run infinityvault -- token</code>. It is stored in{' '}
          <code>~/.config/infinityvault/.env</code>.
        </p>
      </form>
    </div>
  )
}
