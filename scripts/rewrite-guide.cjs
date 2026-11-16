const fs = require('fs')

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n')
const out = []
const insertAfterStep3 = []
const step3 = []

const replacements = {
  historyImportGuideTitle: "  historyImportGuideTitle: '怎么把聊天记录导进 DS Lite',",
  historyImportGuideStep1:
    "  historyImportGuideStep1: '在 DeepSeek App 里打开：**设置 → 数据管理 → 导出聊天记录**，点「导出」',",
  historyImportGuideStep2:
    "  historyImportGuideStep2: '导出完会给你一个**下载链接**，点它在浏览器里下载，得到一个 **ZIP 压缩包**（一般叫 chat_history_xxx.zip），**存到手机文件里**',",
  historyImportGuideStep3:
    "  historyImportGuideStep3: '回到 DS Lite：**设置 → 数据管理 → 导入历史对话**，点「上传」，在文件管理器里选中这个 ZIP',",
  historyImportGuideNote:
    "  historyImportGuideNote: '找不到那个 ZIP？可能是下载在电脑上——用微信「文件传输助手」或数据线传到手机，再回来选。只勾需要的对话，包越大导入越慢。',",
}

const added = [
  "  historyImportGuideStep4: '等进度条走完就完成了。导入过程中**别退出应用、别锁屏**，包大时要几分钟',",
  "  historyImportGuideStep5: '导入是**覆盖**：这个 ZIP 会替换本机现在的全部会话，之前没导出过的记录会丢，**先导出备份再导入**',",
  "  historyImportGuideCaution: '**千万别把这个 ZIP 发到聊天框里**——它不是给人看的，发进去只会变成一条打不开的附件；DS Lite 也读不懂聊天框里的文件，只能在「设置 → 导入历史对话」里选它。',",
]

for (const line of lines) {
  const key = (line.match(/^  (\w+):/) || [])[1]
  if (key && Object.prototype.hasOwnProperty.call(replacements, key)) {
    out.push(replacements[key])
    if (key === 'historyImportGuideStep3') added.forEach((item) => out.push(item))
    continue
  }
  out.push(line)
}

fs.writeFileSync(file, out.join('\n'))
console.log('done')
