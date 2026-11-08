// Verifies Phase 1.2 pagination in a real browser against the 520-row
// scratch library on port 8051.
// Run: node scripts/check-pagination.mjs
import { chromium } from 'playwright'

const APP = 'http://127.0.0.1:5180/'
const CLIENT = 'c1'

const results = []
function check(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

// The app reads its client id from localStorage, so pin it to our test data.
await page.addInitScript((id) => {
  window.localStorage.setItem('infinityvault-client-id', id)
}, CLIENT)

const mediaRequests = []
page.on('request', (r) => {
  if (r.url().includes('/api/media?')) mediaRequests.push(r.url())
})

await page.goto(APP, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)

// 1. First paint uses a limited page, not the whole library.
const first = mediaRequests[0] ?? ''
check('first request includes limit=', /limit=\d+/.test(first), first.split('/api/')[1]?.slice(0, 60))
check('first request has no cursor', !/cursor=/.test(first))

const tilesBefore = await page.locator('.media-grid .media-card, .media-grid img, .media-grid video').count()
check('grid rendered tiles', tilesBefore > 0, `${tilesBefore} tiles`)

// 2. Load more appears and appends.
const loadMore = page.locator('.load-more button')
const hasButton = await loadMore.count() > 0
check('Load more button present', hasButton)

if (hasButton) {
  const before = await page.locator('.media-card').count()
  await loadMore.scrollIntoViewIfNeeded()
  await loadMore.click()
  await page.waitForTimeout(2500)
  const after = await page.locator('.media-card').count()
  check('Load more appended tiles', after > before, `${before} -> ${after}`)
  const withCursor = mediaRequests.filter((u) => u.includes('cursor='))
  check('cursor was sent', withCursor.length > 0, `${withCursor.length} cursor request(s)`)
} else {
  check('Load more appended tiles', false, 'button missing')
}

// 3. No duplicate tiles after appending (the classic keyset bug).
const ids = await page.locator('.media-card').evaluateAll((els) => els.map((e) => e.getAttribute('data-id') || e.textContent))
const unique = new Set(ids)
check('no duplicate tiles', ids.length === unique.size, `${ids.length} tiles, ${unique.size} unique`)

// 4. Switching views resets to a single page (no stale accumulation).
await page.locator('text=Favorites').first().click().catch(() => {})
await page.waitForTimeout(2000)
const favReq = mediaRequests[mediaRequests.length - 1] ?? ''
check('view switch restarts at page 1', !/cursor=/.test(favReq), favReq.split('/api/')[1]?.slice(0, 50))

await page.screenshot({ path: '/tmp/pagination-check.png', fullPage: false })
await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
