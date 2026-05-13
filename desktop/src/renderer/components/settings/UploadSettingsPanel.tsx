import type { UploadSettingsState } from '../../lib/upload-config'

type UploadSettingsPanelProps = {
  uploadDraft: UploadSettingsState
  uploadHasChanges: boolean
  onUpdateProvider: (provider: UploadSettingsState['provider']) => void
  onUpdateAliyunField: (key: string, value: string) => void
  onUpdateQiniuField: (key: string, value: string) => void
  onSave: () => void
  revealUploadSecrets: Record<string, boolean>
  onToggleSecret: (key: string) => void
}

export function UploadSettingsPanel({
  uploadDraft,
  uploadHasChanges,
  onUpdateProvider,
  onUpdateAliyunField,
  onUpdateQiniuField,
  onSave,
  revealUploadSecrets,
  onToggleSecret,
}: Readonly<UploadSettingsPanelProps>) {
  return (
    <div className="settings-card">
      <div className="settings-card-title">上传配置（公网媒体）</div>
      <div className="settings-card-desc">
        当消息包含本地媒体路径时，可先上传到你配置的对象存储，再以公网 https URL 发送给模型。
      </div>
      <div className="settings-grid">
        <label className="settings-field">
          <span>上传服务</span>
          <select
            value={uploadDraft.provider}
            onChange={(e) => onUpdateProvider(e.target.value as UploadSettingsState['provider'])}
          >
            <option value="none">不启用</option>
            <option value="aliyun_oss">阿里云 OSS</option>
            <option value="qiniu">七牛云</option>
          </select>
        </label>
      </div>

      {uploadDraft.provider === 'aliyun_oss' && (
        <div className="settings-grid" style={{ marginTop: 12 }}>
          <label className="settings-field">
            <span>AccessKey ID</span>
            <input
              value={uploadDraft.aliyunOss.accessKeyId}
              onChange={(e) => onUpdateAliyunField('accessKeyId', e.target.value)}
              placeholder="LTAI..."
            />
          </label>
          <label className="settings-field">
            <span>AccessKey Secret</span>
            <div className="api-key-row">
              <input
                type={revealUploadSecrets.aliyunSecret ? 'text' : 'password'}
                value={uploadDraft.aliyunOss.accessKeySecret}
                onChange={(e) => onUpdateAliyunField('accessKeySecret', e.target.value)}
                placeholder="请输入 AccessKey Secret"
              />
              <button
                type="button"
                className="reveal-btn"
                onClick={() => onToggleSecret('aliyunSecret')}
              >
                {revealUploadSecrets.aliyunSecret ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
          <label className="settings-field">
            <span>Bucket</span>
            <input
              value={uploadDraft.aliyunOss.bucket}
              onChange={(e) => onUpdateAliyunField('bucket', e.target.value)}
              placeholder="my-bucket"
            />
          </label>
          <label className="settings-field">
            <span>Endpoint</span>
            <input
              value={uploadDraft.aliyunOss.endpoint}
              onChange={(e) => onUpdateAliyunField('endpoint', e.target.value)}
              placeholder="oss-cn-beijing.aliyuncs.com"
            />
          </label>
          <label className="settings-field">
            <span>公网访问前缀（可选）</span>
            <input
              value={uploadDraft.aliyunOss.publicBaseUrl}
              onChange={(e) => onUpdateAliyunField('publicBaseUrl', e.target.value)}
              placeholder="https://cdn.example.com"
            />
          </label>
          <label className="settings-field">
            <span>对象前缀（可选）</span>
            <input
              value={uploadDraft.aliyunOss.objectPrefix}
              onChange={(e) => onUpdateAliyunField('objectPrefix', e.target.value)}
              placeholder="taco/uploads"
            />
          </label>
        </div>
      )}

      {uploadDraft.provider === 'qiniu' && (
        <div className="settings-grid" style={{ marginTop: 12 }}>
          <label className="settings-field">
            <span>AccessKey</span>
            <input
              value={uploadDraft.qiniu.accessKey}
              onChange={(e) => onUpdateQiniuField('accessKey', e.target.value)}
              placeholder="请输入七牛 AccessKey"
            />
          </label>
          <label className="settings-field">
            <span>SecretKey</span>
            <div className="api-key-row">
              <input
                type={revealUploadSecrets.qiniuSecret ? 'text' : 'password'}
                value={uploadDraft.qiniu.secretKey}
                onChange={(e) => onUpdateQiniuField('secretKey', e.target.value)}
                placeholder="请输入七牛 SecretKey"
              />
              <button
                type="button"
                className="reveal-btn"
                onClick={() => onToggleSecret('qiniuSecret')}
              >
                {revealUploadSecrets.qiniuSecret ? '隐藏' : '显示'}
              </button>
            </div>
          </label>
          <label className="settings-field">
            <span>Bucket</span>
            <input
              value={uploadDraft.qiniu.bucket}
              onChange={(e) => onUpdateQiniuField('bucket', e.target.value)}
              placeholder="my-bucket"
            />
          </label>
          <label className="settings-field">
            <span>上传地址（可选）</span>
            <input
              value={uploadDraft.qiniu.uploadUrl}
              onChange={(e) => onUpdateQiniuField('uploadUrl', e.target.value)}
              placeholder="https://up.qiniup.com"
            />
          </label>
          <label className="settings-field">
            <span>公网访问前缀</span>
            <input
              value={uploadDraft.qiniu.publicBaseUrl}
              onChange={(e) => onUpdateQiniuField('publicBaseUrl', e.target.value)}
              placeholder="https://cdn.example.com"
            />
          </label>
          <label className="settings-field">
            <span>对象前缀（可选）</span>
            <input
              value={uploadDraft.qiniu.objectPrefix}
              onChange={(e) => onUpdateQiniuField('objectPrefix', e.target.value)}
              placeholder="taco/uploads"
            />
          </label>
          <label className="settings-field">
            <span>Token 有效期（秒，可选）</span>
            <input
              type="number"
              min={60}
              step={60}
              value={uploadDraft.qiniu.expiresSeconds}
              onChange={(e) => onUpdateQiniuField('expiresSeconds', e.target.value)}
              placeholder="3600"
            />
          </label>
        </div>
      )}

      <div className="settings-action-row">
        <div className="settings-action-info">
          <strong>{uploadHasChanges ? '有未保存修改' : '已保存'}</strong>
          <small>仅本机保存；启用后会用于本地媒体文件上传。</small>
        </div>
        <button
          type="button"
          className="settings-action-btn"
          disabled={!uploadHasChanges}
          onClick={onSave}
        >
          保存上传配置
        </button>
      </div>
    </div>
  )
}
