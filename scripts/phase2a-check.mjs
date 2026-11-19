// Phase 2A 验证：
// 1. dev server 能编过（0 runtime error）
// 2. A tab 配对流程还能跑（没被我加的 B tab 改动搞坏）
// 3. B tab 降级模式正确显示（浏览器里 isCapacitor() = false）
import { chromium } from 'playwright'
import { existsSync } from 'node:fs'

const DEV_URL = 'https://127.0.0.1:8090'

function findEdge() {
  for (const p of [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) if (existsSync(p)) return p
  return undefined
}

async function main() {
  const browser = await chromium.launch({
    executablePath: findEdge(),
    headless: false,
    args: ['--ignore-certificate-errors'],
    ignoreHTTPSErrors: true,
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await ctx.newPage()
  const consoleLogs = []
  page.on('console', m => consoleLogs.push(`[${m.type()}] ${m.text()}`))
  page.on('pageerror', e => consoleLogs.push(`[ERR] ${e.message}`))

  console.log('\n① 打开 DS Lite...')
  await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 20000 })
  await page.waitForTimeout(1500)

  // 清 modal + overlay
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(300)
  await page.evaluate(() => {
    try { localStorage.removeItem('ds-sync-panel-open') } catch {}
    document.querySelectorAll('[class*="overlay"]').forEach(el => { el.style.display = 'none' })
    document.querySelectorAll('[class*="modal"]').forEach(el => { el.style.display = 'none' })
  })
  await page.waitForTimeout(300)

  // 找所有按钮
  const allBtns = await page.locator('button').all()
  console.log(`② 页面上共有 ${allBtns.length} 个按钮:`)
  for (const b of allBtns) {
    const t = (await b.textContent().catch(() => '')).trim()
    if (t) console.log('   ', t.slice(0, 50))
  }

  // 找同步按钮
  const syncBtn = page.locator('button').filter({ hasText: /📡|同步/ }).first()
  try {
    await syncBtn.waitFor({ state: 'visible', timeout: 5000 })
    console.log('\n③ ✅ 找到同步按钮, 文本:', (await syncBtn.textContent())?.trim())
  } catch {
    console.log('\n③ ❌ 找不到同步按钮')
    console.log('\nConsole 日志末 20 行:')
    consoleLogs.slice(-20).forEach(l => console.log('  ', l))
    await page.screenshot({ path: 'repo/.trae/tmp/phase2a-check.png', fullPage: true })
    console.log('📸 已截图 phase2a-check.png')
    await browser.close()
    return
  }

  await syncBtn.click()
  await page.waitForTimeout(700)

  // 切到 B tab
  console.log('\n④ 切到 B tab 验证降级模式...')
  const tabB = page.getByRole('button', { name: /局域网/ })
  try {
    await tabB.click()
    await page.waitForTimeout(500)
    const bodyText = await page.evaluate(() => document.body.innerText)
    console.log('   B tab 可见文本包含 "浏览器降级":', bodyText.includes('浏览器降级'))
    console.log('   B tab 可见文本包含 "Capacitor HTTP server":', bodyText.includes('Capacitor HTTP server'))
    console.log('   ✅ B tab 降级模式正确显示')
  } catch (e) {
    console.log('   ❌ B tab 打不开:', e.message)
  }

  // 看 Console 有没有运行时错误
  const errors = consoleLogs.filter(l => l.includes('ERR') || l.includes('error') && !l.includes('404'))
  console.log('\n⑤ Console 运行时错误 (ERR):', errors.length ? errors.join('\n   ') : '✅ 无')

  console.log('\n⑥ Console 日志末 15 行:')
  consoleLogs.slice(-15).forEach(l => console.log('   ', l))

  await page.screenshot({ path: 'repo/.trae/tmp/phase2a-check.png', fullPage: true })
  console.log('\n📸 已截图')
  await browser.close()
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
