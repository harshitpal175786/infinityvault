import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 1100 } })
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await p.waitForTimeout(2500)
await p.locator('.nav-item:has-text("Utilities")').first().click()
await p.waitForTimeout(3000)
const btns = await p.locator('button').allInnerTexts()
console.log('buttons:', btns.filter(t=>t.trim()).slice(0,14).join(' | '))
