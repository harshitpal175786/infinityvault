import { chromium } from 'playwright'
const b = await chromium.launch()
const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
const errs = []
p.on('pageerror', e => errs.push(e.message))
p.on('response', r => { if (r.status() >= 500) errs.push(`${r.status()} ${r.url().split('/api/')[1]?.slice(0,40)}`) })
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle', timeout: 90000 })
await p.waitForTimeout(6000)
await p.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(()=>{}))))
const s = await p.evaluate(() => {
  const imgs = [...document.images]
  return { imgs: imgs.length, loaded: imgs.filter(i => i.naturalWidth > 0).length }
})
console.log('header:', await p.locator('.library-heading-meta').innerText())
console.log('tiles :', await p.locator('.media-card').count(), '| images', JSON.stringify(s))
console.log('errors:', errs.length ? [...new Set(errs)].slice(0,3) : 'none')
await p.screenshot({ path: '../.shots/final-grid.png' })
await b.close()
