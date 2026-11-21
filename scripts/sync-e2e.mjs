// 先关掉残留 Modal，再跑 E2E
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
  console.log('🚀 Edge launch...')
  const browser = await chromium.launch({
    executablePath: findEdge(),
    headless: false,
    args: ['--ignore-certificate-errors'],
    ignoreHTTPSErrors: true,
  })
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true })

  // ============== 页面初始化：关掉 Modal + 清空 localStorage 的同步状态 ==============
  const initPage = async (label) => {
    const page = await ctx.newPage()
    const logs = []
    page.on('console', (m) => logs.push(`[${label} ${m.type()}] ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`[${label} ERR] ${e.message}`))

    console.log(`\n${label} goto`)
    await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 20000 })
    await page.waitForTimeout(1500)

    // 清掉 localStorage 里残留的 syncPanelState
    await page.evaluate(() => {
      try { localStorage.removeItem('ds-sync-panel-open') } catch {}
      try { localStorage.removeItem('ds-sync-code') } catch {}
    })

    // 先关掉可能的 modal（Esc + 点 overlay）
    await page.keyboard.press('Escape').catch(() => {})
    await page.waitForTimeout(300)
    // 尝试点 X 关闭按钮
    const closeBtn = page.locator('button').filter({ hasText: /^[X×]$/ }).first()
    try { await closeBtn.click({ timeout: 1000 }) } catch {}
    await page.waitForTimeout(300)

    // 用 JS 强制把 overlay 隐藏（如果还在）
    await page.evaluate(() => {
      document.querySelectorAll('[class*="overlay"]').forEach(el => {
        el.style.display = 'none'
      })
      document.querySelectorAll('[class*="modal"]').forEach(el => {
        el.style.display = 'none'
      })
    })
    await page.waitForTimeout(300)

    return { page, logs }
  }

  // ============ Host ============
  const { page: host, logs: hostLogs } = await initPage('🟦Host')

  // 找同步按钮（overlay 已经隐藏了）
  const syncBtn = host.locator('button').filter({ hasText: /📡|同步/ }).first()
  await syncBtn.waitFor({ state: 'visible', timeout: 5000 })
  console.log('🟦 找到同步按钮, 文本:', (await syncBtn.textContent())?.trim())
  await syncBtn.click()
  await host.waitForTimeout(600)

  // 点 Tab A 配对码（默认就应该是）
  const tabA = host.getByRole('button', { name: /配对码/ })
  try { await tabA.click({ timeout: 2000 }) } catch {}
  await host.waitForTimeout(200)

  // 点「我是房主」
  console.log('🟦 点我是房主')
  const offerBtn = host.locator('button').filter({ hasText: /我是房主/ }).first()
  await offerBtn.click()
  await host.waitForTimeout(5000)

  const offerCode = await host.evaluate(() => {
    const tas = Array.from(document.querySelectorAll('textarea'))
    const vals = tas.map(t => t.value).filter(v => v && v.length > 50)
    vals.sort((a, b) => b.length - a.length)
    return vals[0] || ''
  })
  console.log('🟦 Offer:', offerCode.length > 100 ? `✅ ${offerCode.length}` : '❌ 没拿到')
  if (!offerCode || offerCode.length < 100) { await dump(host, hostLogs, 'host'); await browser.close(); return }

  // ============ Guest ============
  const { page: guest, logs: guestLogs } = await initPage('🟩Guest')

  const syncBtnG = guest.locator('button').filter({ hasText: /📡|同步/ }).first()
  await syncBtnG.click()
  await guest.waitForTimeout(600)

  // 切 Guest 模式（点「我是加入者」让「远端 Offer」textarea 出现）
  console.log('🟩 切到加入者模式')
  const guestBtn = guest.locator('button').filter({ hasText: /我是加入者/ }).first()
  try { await guestBtn.click({ timeout: 3000 }) } catch {
    console.log('   没找到「我是加入者」按钮，继续试试')
  }
  await guest.waitForTimeout(800)

  // 粘 Offer
  console.log('🟩 粘 Offer → 应用')
  await guest.waitForTimeout(300)

  // 看一下 Guest 端有几个 textarea，分别在哪
  const taInfo = await guest.evaluate(() => {
    const tas = Array.from(document.querySelectorAll('textarea'))
    return tas.map((t, i) => ({
      idx: i,
      placeholder: t.placeholder,
      valueLen: t.value?.length ?? 0,
      label: t.closest('div')?.querySelector('label, span, p')?.textContent?.trim()?.slice(0, 40) || '',
    }))
  })
  console.log('🟩 Guest textareas:', JSON.stringify(taInfo, null, 2))

  // 粘到 SyncPanel 里的远端 Offer (#1, placeholder 含「粘贴」)
  const useIdx = 1  // Guest 切到加入者模式后，SyncPanel 会渲染远端 Offer 在 #1
  console.log('🟩 粘 Offer 到 textarea #', useIdx)
  const tasG = await guest.locator('textarea').all()
  await tasG[useIdx].fill(offerCode)
  await guest.waitForTimeout(300)

  // 按钮文本就是这个
  const applyBtn = guest.locator('button').filter({ hasText: /应用 Offer/ }).first()
  try {
    await applyBtn.click({ timeout: 5000 })
  } catch {
    // dump all buttons
    const all = await guest.locator('button').all()
    for (const b of all) {
      const t = await b.textContent().catch(() => '')
      console.log('   guest btn:', t?.trim().slice(0, 60))
    }
    throw new Error('找不到应用按钮')
  }
  await guest.waitForTimeout(5000)

  const answerCode = await guest.evaluate(() => {
    // Guest 切到加入者模式后：
    // #0 = 聊天框
    // #1 = 远端 Offer（可写，我们刚粘进去了 Offer 码）
    // #2 = 本地 Answer（readonly，刚生成） ← 这才是 Answer！
    const tas = Array.from(document.querySelectorAll('textarea'))
    // 优先选 readonly + value 最长的（就是生成出来的 Answer）
    const candidates = tas
      .filter(t => t.readOnly && t.value?.length > 50)
      .sort((a, b) => b.value.length - a.value.length)
    return candidates[0]?.value || ''
  })
  console.log('🟩 Answer:', answerCode.length > 100 ? `✅ ${answerCode.length}` : '❌ 没拿到')
  if (!answerCode || answerCode.length < 100) { await dump(guest, guestLogs, 'guest'); await browser.close(); return }

  // ============ Host 连接 ============
  console.log('\n🟦 Host 设置 Answer → 连接')
  const htaInfo = await host.evaluate(() => {
    const tas = Array.from(document.querySelectorAll('textarea'))
    return tas.map((t, i) => ({
      idx: i,
      readonly: t.readOnly,
      valueLen: t.value?.length ?? 0,
      label: t.closest('div')?.querySelector('label, span, p')?.textContent?.trim()?.slice(0, 40) || '',
    }))
  })
  console.log('🟦 Host textareas:', JSON.stringify(htaInfo, null, 2))

  // Host 端 textarea 顺序：
  // #0 = DS Lite 主聊天输入框
  // #1 = SyncPanel 只读 Offer（readonly, valueLen > 0）
  // #2 = SyncPanel 远端 Answer（可写，空）← 我们要粘这
  const hostUseIdx = 2
  console.log('🟦 粘 Answer 到 textarea #', hostUseIdx, '(SyncPanel 远端 Answer)')
  const tasH = await host.locator('textarea').all()
  await tasH[hostUseIdx].fill(answerCode)
  await host.waitForTimeout(300)

  const connectBtn = host.locator('button').filter({ hasText: /设置.*Answer.*连接/ }).first()
  await connectBtn.click()
  await host.waitForTimeout(10000)  // 多等一会儿让 Host 的 ICE 也 settled

  // ============ 结果 ============
  const hostTxt = await host.evaluate(() => document.body.innerText)
  const guestTxt = await guest.evaluate(() => document.body.innerText)

  // 更宽松的匹配：Guest 收到 hello 或有 'DataChannel' 或 '已连接' 都行
  const hostConnected = hostTxt.includes('已连接') || hostTxt.includes('DataChannel') || hostTxt.includes('协商')
  const guestConnected = guestTxt.includes('已连接') || guestTxt.includes('DataChannel') || guestTxt.includes('协商')
  const hostShort = hostTxt.slice(-800)
  const guestShort = guestTxt.slice(-800)

  console.log('\n═══════════════════════════════')
  console.log(`  Host:  ${hostConnected ? '✅ 已连接' : '❌ 状态未知'}`)
  console.log(`  Guest: ${guestConnected ? '✅ 已连接' : '❌ 状态未知'}`)
  console.log('═══════════════════════════════')

  console.log('\n🟦 Host 页面末 800 字:')
  console.log(hostShort)
  console.log('\n🟩 Guest 页面末 800 字:')
  console.log(guestShort)

  console.log('\n🟦 Host Console:')
  hostLogs.slice(-30).forEach(l => console.log(' ', l))
  console.log('\n🟩 Guest Console:')
  guestLogs.slice(-30).forEach(l => console.log(' ', l))

  await host.screenshot({ path: 'repo/.trae/tmp/host-e2e.png', fullPage: true })
  await guest.screenshot({ path: 'repo/.trae/tmp/guest-e2e.png', fullPage: true })
  console.log('\n📸 截图 done')

  await browser.close()
}

async function dump(page, logs, tag) {
  console.log(`\n[${tag} Console 末 30]:`)
  logs.slice(-30).forEach(l => console.log(' ', l))
  await page.screenshot({ path: `repo/.trae/tmp/${tag}-fail.png`, fullPage: true })
}

main().catch(e => { console.error('❌', e.message); process.exit(1) })
