const fs = require('fs')

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split('\n')
const out = []

const replacements = {
  historyImportGuideTitle: "  historyImportGuideTitle: 'How to bring your chats into DS Lite',",
  historyImportGuideStep1:
    "  historyImportGuideStep1: 'In the DeepSeek app open **Settings → Data management → Export chat history** and tap Export',",
  historyImportGuideStep2:
    "  historyImportGuideStep2: 'You get a **download link**. Open it in a browser and download the **ZIP archive** (usually chat_history_xxx.zip), then **save it to your phone files**',",
  historyImportGuideStep3:
    "  historyImportGuideStep3: 'Back in DS Lite: **Settings → Data management → Import chat history**, tap Upload and pick that ZIP',",
  historyImportGuideNote:
    "  historyImportGuideNote: 'Cannot find the ZIP? It may be on your computer - send it to the phone with WeChat File Transfer or a cable, then pick it here. Select only the chats you need: bigger archives import slower.',",
  historyImportGuideCaution:
    "  historyImportGuideCaution: '**Never send this ZIP into the chat box.** It is not meant to be read as a message - it just becomes an attachment that cannot open, and DS Lite cannot read files from the chat box. Import it from Settings → Import chat history only.',",
}

const added = [
  "  historyImportGuideStep4: 'Wait for the progress bar to finish. **Do not leave the app or lock the screen** while importing - a big archive takes a few minutes',",
  "  historyImportGuideStep5: 'Importing **replaces** everything: the ZIP overwrites all chats on this device, so anything you never exported is lost. **Export a backup first**',",
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
