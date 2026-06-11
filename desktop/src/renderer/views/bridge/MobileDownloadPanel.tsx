/**
 * MobileDownloadPanel — 手机端下载面板
 *
 * 提供：
 * 1. 扫码下载二维码（手机扫描直接下载安装）
 * 2. 电脑下载 Android 安装包按钮
 *
 * 下载地址优先从版本检查 API 获取，失败时 fallback 到 OSS 硬编码地址。
 */

import { useEffect, useState } from 'react'

const FALLBACK_APK_DOWNLOAD_URL = 'https://tacoai.oss-cn-beijing.aliyuncs.com/app/app-release.apk'
const ANDROID_PACKAGE_NAME = 'cn.zhongnanke.taco'

type MobileDownloadPanelProps = {
  onClose: () => void
}

export function MobileDownloadPanel({ onClose }: Readonly<MobileDownloadPanelProps>) {
  const [downloadUrl, setDownloadUrl] = useState(FALLBACK_APK_DOWNLOAD_URL)

  useEffect(() => {
    let cancelled = false
    window.taco.bridge
      .getMobileApkInfo(ANDROID_PACKAGE_NAME)
      .then((info) => {
        if (!cancelled && info?.downloadUrl) {
          setDownloadUrl(info.downloadUrl)
        }
      })
      .catch(() => {
        // API 失败，继续使用 fallback 地址
      })
    return () => {
      cancelled = true
    }
  }, [])

  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(downloadUrl)}`

  return (
    <div className="bridge-panel mobile-download-panel">
      <div className="bridge-panel-header">
        <h3 className="bridge-panel-title">下载手机端</h3>
        <button
          type="button"
          className="bridge-panel-close"
          onClick={onClose}
          aria-label="关闭下载面板"
        >
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="bridge-panel-body">
        <div className="bridge-pairing-section">
          <div className="bridge-pairing-label">扫码下载</div>

          <div className="bridge-qr-code">
            <img src={qrCodeUrl} alt="手机端下载二维码" width={200} height={200} />
          </div>

          <p className="bridge-pairing-hint">
            使用手机扫描二维码下载安装 Taco AI 手机端
          </p>

          <a
            href={downloadUrl}
            className="bridge-btn bridge-btn-primary"
            download="taco-ai-android.apk"
            target="_blank"
            rel="noopener noreferrer"
          >
            下载 Android 安装包
          </a>
        </div>
      </div>
    </div>
  )
}
