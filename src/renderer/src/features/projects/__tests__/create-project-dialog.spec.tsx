import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  PROJECT_BASE,
  PICKED_FOLDER,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { defaultSettings } from '@shared/settings'
import { CreateProjectDialog, type CreateProjectMode } from '../CreateProjectDialog'

/**
 * 创建项目对话框（T18）：名称必填、路径默认 = 基底 + 同名子目录（blank）/ 选择器（folder）、
 * 保存走 projects:create、失败行内显示原因、成功后回调。
 */
let bridge: KyclawBridgeStubs

function renderDialog(
  mode: CreateProjectMode,
  onCreated = vi.fn()
): {
  onOpenChange: ReturnType<typeof vi.fn>
  onCreated: ReturnType<typeof vi.fn>
} {
  const onOpenChange = vi.fn()
  render(<CreateProjectDialog open mode={mode} onOpenChange={onOpenChange} onCreated={onCreated} />)
  return { onOpenChange, onCreated }
}

beforeEach(() => {
  bridge = installKyclawBridge()
})

afterEach(() => {
  clearKyclawBridge()
})

describe('CreateProjectDialog', () => {
  it('blank：路径随名称变成"基底 + 同名子目录"；名称为空时保存禁用', async () => {
    renderDialog('blank')

    await waitFor(() => {
      expect(screen.getByTestId('project-path-value')).toHaveTextContent(PROJECT_BASE)
    })
    expect(screen.getByTestId('project-create-save')).toBeDisabled()

    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: '插件' } })
    expect(screen.getByTestId('project-path-value')).toHaveTextContent(`${PROJECT_BASE}\\插件`)
    expect(screen.getByTestId('project-create-save')).toBeEnabled()
  })

  it('blank：保存 → projects:create(name, 基底下的同名子目录)，关框并回调新项目 id', async () => {
    const { onOpenChange, onCreated } = renderDialog('blank')

    await waitFor(() => {
      expect(screen.getByTestId('project-path-value')).toHaveTextContent(PROJECT_BASE)
    })
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: ' 插件 ' } })
    fireEvent.click(screen.getByTestId('project-create-save'))

    await waitFor(() => {
      expect(bridge.projects.create).toHaveBeenCalledWith('插件', `${PROJECT_BASE}\\插件`)
    })
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
    expect(onCreated).toHaveBeenCalledWith('project-1')
  })

  it('folder：路径先空着（保存禁用）；点路径行开选择器，挑中的路径钉住', async () => {
    renderDialog('folder')

    expect(screen.getByTestId('project-path-value')).toHaveTextContent('选择文件夹')
    expect(screen.getByTestId('project-create-save')).toBeDisabled()

    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: '现有' } })
    // 名称不该改变 folder 模式的路径（它由选择器给）
    expect(screen.getByTestId('project-create-save')).toBeDisabled()

    fireEvent.click(screen.getByTestId('project-path-field'))
    await waitFor(() => {
      expect(screen.getByTestId('project-path-value')).toHaveTextContent(PICKED_FOLDER)
    })
    expect(screen.getByTestId('project-create-save')).toBeEnabled()

    // 挑中之后名称再改也不动路径（钉住）
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: '换个名' } })
    expect(screen.getByTestId('project-path-value')).toHaveTextContent(PICKED_FOLDER)

    fireEvent.click(screen.getByTestId('project-create-save'))
    await waitFor(() => {
      expect(bridge.projects.create).toHaveBeenCalledWith('换个名', PICKED_FOLDER)
    })
  })

  it('选择器取消：路径保持原样，不报错', async () => {
    bridge.projects.pickFolder.mockResolvedValueOnce({ path: null })
    renderDialog('folder')

    fireEvent.click(screen.getByTestId('project-path-field'))

    await waitFor(() => {
      expect(screen.getByTestId('project-path-value')).toHaveTextContent('选择文件夹')
    })
    expect(screen.queryByTestId('project-create-error')).not.toBeInTheDocument()
  })

  it('保存失败（重复路径 / 路径校验）：行内给原因、不关框、不回调', async () => {
    bridge.projects.create.mockRejectedValueOnce(new Error('这个文件夹已经是一个项目：插件'))
    const { onOpenChange, onCreated } = renderDialog('blank')

    await waitFor(() => {
      expect(screen.getByTestId('project-path-value')).toHaveTextContent(PROJECT_BASE)
    })
    fireEvent.change(screen.getByTestId('project-name-input'), { target: { value: '插件' } })
    fireEvent.click(screen.getByTestId('project-create-save'))

    await waitFor(() => {
      expect(screen.getByTestId('project-create-error')).toHaveTextContent('已经是一个项目')
    })
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('项目基底的取值：走 projects:base（不是硬编码）；落盘里已有项目也不影响', async () => {
    bridge = installKyclawBridge({
      ...defaultSettings(),
      projects: [{ id: 'p9', name: '旧', path: 'D:\\old', createdAt: '2026-10-01T00:00:00.000Z' }]
    })
    renderDialog('blank')

    await waitFor(() => {
      expect(bridge.projects.base).toHaveBeenCalled()
    })
    expect(screen.getByTestId('project-path-value')).toHaveTextContent(PROJECT_BASE)
  })
})
