import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { emptyOverview, type LocalModelsOverview } from '@shared/local-models'
import { defaultSettings } from '@shared/settings'
import { LocalModelSettings } from '../LocalModelSettings'

/**
 * 设置页「本地模型」组（模块 3B）：清单 / 下载进度 / 使用 / 删除 / 自定义文件 / 空闲回收。
 *
 * 两块东西必须在场（UI 雷点）：**零 emoji**、**不放解释性小字**；
 * 进度是主进程推的，所以用例里"下载中"是靠 `bridge.localModels.push()` 喂进去的。
 */
function withDownload(
  overview: LocalModelsOverview,
  id: string,
  percent: number
): LocalModelsOverview {
  const item = overview.items.find((candidate) => candidate.id === id)!
  return {
    ...overview,
    download: {
      id,
      phase: 'downloading',
      received: Math.round((item.bytes * percent) / 100),
      total: item.bytes,
      message: null
    }
  }
}

let bridge: KyclawBridgeStubs

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  bridge = installKyclawBridge()
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('「本地模型」组', () => {
  it('清单一行一个：名称 + 体积 + 定位；顶部说"未选择模型"与引擎状态', async () => {
    render(<LocalModelSettings />)

    expect(await screen.findByTestId('local-engine-model')).toHaveTextContent('未选择模型')
    expect(screen.getByTestId('local-engine-phase')).toHaveTextContent('未启动')
    // 未下载也要显示清单里实测的体积（610MB / 1142MB / 25.2MB…）
    expect(screen.getByTestId('local-model-qwen3-embedding-0.6b-q8')).toHaveTextContent('610 MB')
    expect(screen.getByTestId('local-model-qwen3-embedding-0.6b-q8')).toHaveTextContent(
      '质量优先，多语'
    )
    expect(screen.getByTestId('local-model-bge-small-zh-v1.5-q8')).toHaveTextContent('25.2 MB')
    // 页面不出现 emoji（雷点 1）
    expect(document.body.textContent ?? '').not.toMatch(/[\u{1f300}-\u{1faff}\u{2600}-\u{27bf}]/u)
  })

  it('点「下载」调主进程的下载通道（进度随后由推送来）', async () => {
    render(<LocalModelSettings />)
    fireEvent.click(await screen.findByTestId('local-model-bge-small-zh-v1.5-q8-download'))
    await waitFor(() =>
      expect(bridge.localModels.download).toHaveBeenCalledWith('bge-small-zh-v1.5-q8')
    )
  })

  it('下载中：显示进度条与百分比，按钮换成「取消」', async () => {
    render(<LocalModelSettings />)
    const pushed = withDownload(emptyOverview('D:\\models'), 'qwen3-embedding-0.6b-q8', 42)
    bridge.localModels.push(pushed)

    const bar = await screen.findByTestId('local-model-qwen3-embedding-0.6b-q8-bar')
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByTestId('local-model-qwen3-embedding-0.6b-q8-percent')).toHaveTextContent(
      '42%'
    )
    expect(screen.getByTestId('local-model-qwen3-embedding-0.6b-q8-cancel')).toBeInTheDocument()
    // 同一时间只允许一个下载：别的档的下载按钮被禁掉
    expect(screen.getByTestId('local-model-bge-small-zh-v1.5-q8-download')).toBeDisabled()

    fireEvent.click(screen.getByTestId('local-model-qwen3-embedding-0.6b-q8-cancel'))
    await waitFor(() => expect(bridge.localModels.cancel).toHaveBeenCalled())
  })

  it('已下载：「使用」与「删除」；生效中的那条标「当前」且不能再点「使用」', async () => {
    const overview = emptyOverview('D:\\models')
    overview.items = overview.items.map((item) =>
      item.id === 'bge-m3-q4-k-m'
        ? {
            ...item,
            downloaded: true,
            installedBytes: 437778496,
            source: 'modelscope' as const,
            active: true
          }
        : item
    )
    overview.activeId = 'bge-m3-q4-k-m'

    render(<LocalModelSettings />)
    bridge.localModels.push(overview)

    expect(await screen.findByTestId('local-model-bge-m3-q4-k-m-active')).toHaveTextContent('当前')
    expect(screen.getByTestId('local-model-bge-m3-q4-k-m-use')).toBeDisabled()
    expect(screen.getByTestId('local-model-bge-m3-q4-k-m')).toHaveTextContent('417 MB 已占用')

    fireEvent.click(screen.getByTestId('local-model-bge-m3-q4-k-m-remove'))
    await waitFor(() => expect(bridge.localModels.remove).toHaveBeenCalledWith('bge-m3-q4-k-m'))
  })

  it('「选择本机模型文件」走原生选择器通道（渲染端递不了路径）', async () => {
    render(<LocalModelSettings />)
    fireEvent.click(await screen.findByTestId('local-model-pick-custom'))
    await waitFor(() => expect(bridge.localModels.pickCustom).toHaveBeenCalled())
  })

  it('选好模型但引擎还没起：状态行说"重启应用后启用"，不假装当场生效', async () => {
    const overview = emptyOverview('D:\\models')
    overview.items = overview.items.map((item) =>
      item.id === 'bge-small-zh-v1.5-q8'
        ? {
            ...item,
            downloaded: true,
            installedBytes: 26472640,
            source: 'modelscope' as const,
            active: true
          }
        : item
    )
    overview.activeId = 'bge-small-zh-v1.5-q8'
    overview.engine = { phase: 'stopped', modelId: null, detail: null }

    render(<LocalModelSettings />)
    bridge.localModels.push(overview)

    expect(await screen.findByTestId('local-engine-model')).toHaveTextContent(
      'bge-small-zh-v1.5（Q8_0）'
    )
    expect(screen.getByTestId('local-engine-phase')).toHaveTextContent('重启应用后启用')
  })

  it('空闲回收档位落盘（0 = 不释放）', async () => {
    render(<LocalModelSettings />)
    fireEvent.click(await screen.findByTestId('local-idle-30'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        expect.objectContaining({
          semanticRecall: expect.objectContaining({ idleMinutes: 30 })
        })
      )
    )
  })

  it('动作失败：错误落在行内（人话，不把 IPC 包装露出来）', async () => {
    bridge.localModels.download.mockRejectedValue(
      new Error(
        "Error invoking remote method 'localModels:download': Error: 磁盘空间不够：还需要约 610 MB"
      )
    )
    render(<LocalModelSettings />)
    fireEvent.click(await screen.findByTestId('local-model-qwen3-embedding-0.6b-q8-download'))

    const error = await screen.findByTestId('local-model-error')
    expect(error).toHaveTextContent('磁盘空间不够')
    expect(error.textContent ?? '').not.toContain('Error invoking remote method')
  })
})
