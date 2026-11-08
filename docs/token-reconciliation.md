# Token reconciliation against Immich source

Source: `immich-app/immich` at `87ef895` (shallow sparse clone, `web/src`),
plus `web/src/app.css` and `web/src/lib/managers/VirtualScrollManager/`.
Cloned to `/tmp/immich-ref` for reference only; **no Immich code is copied
into InfinityVault.** This file records observed values so our own tokens
can be chosen deliberately.

## Corrections to the PRD

The PRD (`docs/prd-ui-immich-alignment.md` §3) was written from Material 3
naming and public PR discussion. The real source corrects three things.

### 1. Immich is not a fixed-column grid — it is a justified layout

`VirtualScrollManager.svelte.ts`:

```ts
setLayoutOptions({ headerHeight = 48, rowHeight = 235, gap = 12 })
```

Each asset carries a `ratio` (`types.ts: TimelineAsset.ratio`), and rows are
justified to fill viewport width at a target row height of 235px. This is
why Immich tiles look naturally sized rather than uniformly square.

**Decision for InfinityVault:** a justified layout needs per-asset aspect
ratio, which requires the backend to report reliable `width`/`height`. Our
`media_items` table *has* those columns but they are nullable and currently
often null. So:

- **This PRD:** `repeat(auto-fill, minmax(...))` square tiles, as specified.
- Increase tile target to **180px** (from my speculated 158px) so density
  lands closer to Immich's 235px justified look without the ratio engine.
- **Follow-up PRD:** justified layout once `width`/`height` are reliably
  populated. Tracked, not silently dropped.

### 2. Immich's tokens are 4 role pairs, not a full M3 surface ladder

`web/src/app.css`, `@layer base`:

```css
--immich-primary: 66 80 175;      /* #4250AF */
--immich-bg: 255 255 255;
--immich-fg: 0 0 0;

--immich-dark-primary: 172 203 250;  /* #ACC BFA */
--immich-dark-bg: 10 10 10;          /* #0A0A0A */
--immich-dark-fg: 229 231 235;       /* #E5E7EB */
--immich-dark-gray: 33 33 33;        /* #212121 */
```

Values are stored as **space-separated RGB channels** (`66 80 175`) consumed
via `rgb(var(--immich-primary))`. This is a good pattern and we adopt it,
because it makes `rgb(... / 0.5)` alpha compositing trivial without a second
opacity token.

Note `--immich-primary` is **#4250AF**, not the `#4155bb` I speculated in the
PRD. Our current CSS already uses `--immich-blue: #4255b8` — close, but the
real value is the target.

### 3. The rest of the palette comes from `@immich/ui`, not this repo

`app.css` imports `@immich/ui/theme/default.css` and references
`--immich-ui-light-100`, `--immich-ui-light-600`, `--immich-ui-dark`,
`--immich-ui-primary-500`. Those are Tailwind-based scale variables defined
in a separate package we are not vendoring.

**Consequence:** we cannot lift a complete token table from open source
without copying AGPL package code. We keep our own semantic scale (§3 of the
PRD) but **align the four anchor values above exactly**, so the accent and
the two dark surfaces match Immich visually.

### 4. Typography is Google Sans, self-hosted

```css
--font-sans: 'GoogleSans', sans-serif;
--font-mono: 'GoogleSansCode', monospace;
```

Included as variable `.ttf` under `web/src/lib/assets/fonts/`. Google Sans is
**not** openly licensed for redistribution (SIL OFL does not cover it), so we
do **not** copy it. We use **Inter** (OFL, freely redistributable), which is
metrically close and already ubiquitous.

The `letter-spacing: 0.1px` body setting is worth keeping — it is a large
part of why Immich text feels calm at small sizes.

### 5. Theme handling

`ThemeButton.svelte` delegates to `ThemePreference` / `ThemeSwitcher` from
`@immich/ui`, and **hides the switcher entirely when the preference is
`System`** — i.e. the toggle only renders once the user has made an explicit
choice. Dark mode is applied via a `.dark` class on `:root` plus
`color-scheme` (`:root.dark { color-scheme: dark }`).

Our approach: `data-theme` attribute (clearer than a bare `.dark` class for
targeting), plus `color-scheme` set in both directions so native scrollbars
and form controls follow. We keep the toggle always visible rather than
hiding it on `System` — hiding a control the user needs to find is worse UX
than a slightly noisier sidebar footer.

## Resulting token decisions

| Token | PRD (speculated) | Final (reconciled) | Source |
| --- | --- | --- | --- |
| `--primary` | `#4155bb` | **`#4250af`** | Immich `--immich-primary` |
| dark `--primary` | `#8fa2ff` | **`#accbfa`** | Immich `--immich-dark-primary` |
| dark `--bg` | `#111318` | **`#0a0a0a`** | Immich `--immich-dark-bg` |
| dark `--surface` | `#1a1d24` | **`#212121`** | Immich `--immich-dark-gray` |
| dark `--on-surface` | `#eef1f6` | **`#e5e7eb`** | Immich `--immich-dark-fg` |
| tile target | 158px | **180px** | derived from 235px row height |
| media gap | 2px | **2px** (timeline) / 12px (album grids) | Immich `gap: 12` at row level |
| font | Inter | **Inter** (theirs is Google Sans, not redistributable) | §4 above |
| body tracking | — | **`0.1px`** | Immich `letter-spacing` |
