/**
 * OCR 文字识别 — 基于 Tesseract.js
 *
 * 跨平台（macOS / Windows / Linux）统一接口。
 * 首次调用自动下载中英文语言包（~12MB），之后缓存复用。
 */

import path from 'path'
import { createWorker } from 'tesseract.js'

let _worker: Tesseract.Worker | null = null

/** 覆盖默认 workerPath，指向 Node.js 版 worker（非浏览器 dist/worker.min.js） */
function resolveWorkerPath(): string {
  const tessEntry = require.resolve('tesseract.js')
  // tessEntry ≈ tesseract.js/src/index.js，同级的 worker-script/node/index.js 是 Node 版 worker
  return path.join(path.dirname(tessEntry), 'worker-script', 'node', 'index.js')
}

export interface OcrWord {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
  confidence: number
}

export interface OcrResult {
  words: OcrWord[]
  text: string
  /** 每个 bbox 的中心点即精确点击坐标 */
  hint: string
}

/** 获取或初始化 Tesseract worker（单例） */
async function getWorker(): Promise<Tesseract.Worker> {
  if (_worker) return _worker

  _worker = await createWorker('chi_sim+eng', 1, {
    workerPath: resolveWorkerPath(),
  })
  return _worker
}

/**
 * 识别图片中的文字，返回所有文字块及精确坐标
 *
 * @param image 图片来源：data: URL (base64)、https: URL、或本地文件路径
 */
export async function recognizeImage(image: string): Promise<OcrResult> {
  const worker = await getWorker()

  const { data } = await worker.recognize(image)

  // Page.blocks → Block.paragraphs → Paragraph.lines → Line.words
  const words: OcrWord[] = []
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs) {
      for (const line of para.lines) {
        for (const word of line.words) {
          words.push({
            text: word.text,
            bbox: { x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 },
            confidence: word.confidence,
          })
        }
      }
    }
  }

  return {
    words,
    text: data.text,
    hint: '每个 bbox 的中心点即精确点击坐标。例如 "保存" 在 bbox (x0,y0)-(x1,y1) → 点击 ((x0+x1)/2, (y0+y1)/2)',
  }
}

/** 释放 Tesseract worker，释放内存 */
export async function terminateOcr(): Promise<void> {
  if (_worker) {
    await _worker.terminate()
    _worker = null
  }
}
