import type { CSSProperties } from 'react'

/**
 * 隐藏的 <input type="file">：**不要用 hidden / display:none**。
 * iOS Safari 里对 display:none 的文件输入点 click() 常常不弹选择器（网页版上传没反应的根因），
 * 所以改成移出可视区但仍在布局树里的写法。
 */
export const HIDDEN_FILE_INPUT_STYLE: CSSProperties = {
  position: 'absolute',
  left: -9999,
  top: 0,
  width: 1,
  height: 1,
  opacity: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
}
