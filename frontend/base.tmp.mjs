import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1400, height: 1000 } })
await p.addInitScript((id) => window.localStorage.setItem('infinityvault-client-id', id), 'c1')
await p.goto('http://127.0.0.1:5180/', { waitUntil: 'networkidle' })
await p.waitForTimeout(2200)
await p.screenshot({ path: 'BASE.png', fullPage: false })
const sig = await p.evaluate(() => ({
  cards: document.querySelectorAll('.media-card, .photo-card, [class*="tile"]').length,
  nav: [...document.querySelectorAll('.nav-item')].map(e => e.textContent?.trim()).join('|').slice(0, 120),
  heading: document.querySelector('h1')?.textContent,
  meta: document.querySelector('.library-heading-meta')?.textContent,
}))
console.log(JSON.stringify(sig))
await b.close()
