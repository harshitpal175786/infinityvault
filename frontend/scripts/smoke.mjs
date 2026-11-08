/**
 * Permanent smoke test for InfinityVault.
 *
 * Every phase before this one was verified with throwaway Playwright scripts
 * that were deleted afterwards, so none of the behaviour established in Phases
 * 1-8 was protected against regression. This script keeps the cheap, high-value
 * assertions around.
 *
 * Run with the dev server and backend already up:
 *   npm run smoke
 *
 * Exits non-zero on the first failed assertion.
 */
import { chromium } from 'playwright'

const URL = process.env.SMOKE_URL || 'http://127.0.0.1:5173/'
const results = []

function check(name, passed, detail = '') {
  results.push({ name, passed, detail })
  const mark = passed ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
  return passed
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const consoleErrors = []
page.on('pageerror', (error) => consoleErrors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200))
})

try {
  console.log('\nLibrary')
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('.media-card', { timeout: 30000 })
  await page.waitForTimeout(1500)

  const firstPage = await page.evaluate(() => {
    const card = document.querySelector('.media-card')
    const rect = card.getBoundingClientRect()
    return {
      tiles: document.querySelectorAll('.media-card').length,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
    }
  })

  check('grid renders a first page of tiles', firstPage.tiles >= 100, `${firstPage.tiles} tiles`)
  check(
    'tiles stay square at 192px',
    firstPage.width === 192 && firstPage.height === 192,
    `${firstPage.width}x${firstPage.height}`,
  )
  check('grid origin is unchanged', firstPage.x === 260 && firstPage.y === 248, `x=${firstPage.x} y=${firstPage.y}`)

  // Infinite scroll: scrolling alone must add tiles, with no button to press.
  const beforeScroll = firstPage.tiles
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(3500)
  const afterScroll = await page.locator('.media-card').count()
  check('scrolling loads more tiles without a button', afterScroll > beforeScroll, `${beforeScroll} -> ${afterScroll}`)

  console.log('\nSearch')
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(400)
  const input = page.locator('.search-field input').first()
  await input.click()
  await input.fill('zzzz-no-such-file')
  await page.waitForTimeout(2500)
  const emptyState = await page.evaluate(() => ({
    headline: document.querySelector('.empty-state h3')?.textContent ?? null,
    tiles: document.querySelectorAll('.media-card').length,
  }))
  check('a hopeless query shows a search-specific empty state', Boolean(emptyState.headline), emptyState.headline ?? 'none')
  check('a hopeless query shows no tiles', emptyState.tiles === 0, `${emptyState.tiles} tiles`)

  await page.evaluate(() => document.querySelector('.empty-state button')?.click())
  await page.waitForTimeout(2500)
  const restored = await page.locator('.media-card').count()
  check('clearing the search restores the library', restored > 0, `${restored} tiles`)

  console.log('\nViews')
  for (const [label, marker] of [['People', '.people-page, .person-card'], ['Albums', '.albums-page, .album-card'], ['Utilities', '.utilities-page, .utility-card']]) {
    const clicked = await page.evaluate((name) => {
      const button = [...document.querySelectorAll('.nav-item')].find((node) => node.textContent.includes(name))
      if (!button) return false
      button.click()
      return true
    }, label)
    await page.waitForTimeout(1800)
    const rendered = await page.evaluate((selector) => Boolean(document.querySelector(selector)), marker)
    check(`${label} view opens`, clicked && rendered, rendered ? '' : 'nothing rendered')
  }

  const settings = await page.evaluate(() => {
    const button = [...document.querySelectorAll('.nav-item')].find((node) => node.textContent.includes('Settings'))
    button?.click()
    return Boolean(button)
  })
  await page.waitForTimeout(2500)
  const settingsContent = await page.evaluate(() => ({
    sections: [...document.querySelectorAll('.settings-section h2')].map((h) => h.textContent),
    rows: document.querySelectorAll('.settings-row').length,
  }))
  check('Settings page opens', settings, '')
  // Assert the actual names, not just a count: counting alone let a renamed
  // section pass, which I confirmed by deliberately breaking it.
  const expectedSections = ['Status', 'Appearance', 'Maintenance']
  check(
    'Settings shows its three named sections',
    expectedSections.every((name) => settingsContent.sections.includes(name)),
    settingsContent.sections.join(', ') || 'none',
  )
  check('Settings renders status rows', settingsContent.rows >= 5, `${settingsContent.rows} rows`)

  console.log('\nRuntime')
  const fatal = consoleErrors.filter((message) => !/favicon|ResizeObserver/i.test(message))
  check('no page errors or console errors', fatal.length === 0, fatal.slice(0, 2).join(' | ') || 'clean')
  check('no crash fallback is showing', !(await page.evaluate(() => Boolean(document.querySelector('.crash-screen')))), '')
} catch (error) {
  check('smoke run completed without throwing', false, error.message)
} finally {
  await browser.close()
}

const failed = results.filter((result) => !result.passed)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log('Failed:')
  failed.forEach((result) => console.log(`  - ${result.name} (${result.detail})`))
  process.exit(1)
}
