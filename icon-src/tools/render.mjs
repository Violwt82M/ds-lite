import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'

const svg = readFileSync('../deepseek.svg', 'utf8')
const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 1024 }, background: 'white' })
writeFileSync('../whale-1024.png', resvg.render().asPng())
console.log('rendered whale-1024.png')
