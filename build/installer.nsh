; kyclaw 卸载器增强（经 electron-builder `nsis.include` 注入，改成构建时挂载）
;
; 目标（用户 2026-10-20 口径）：卸载界面给一个**勾选框**，勾选则同时删除本机上的历史数据。
;
; 为什么挂在 `customUnWelcomePage` 上：
;   assisted 安装器的默认「卸载欢迎页」会被这个宏替换；选择必须在卸载 section 执行**之前**
;   收集完（真正的删除在 `customUnInstall` 里、section 开头做）。
;
; 删除范围（用户拍板）：
;   - `%APPDATA%\kyclaw`            —— 会话（含内核 dsh-home）、设置、加密密钥、日志、模型缓存、旧 kyclaw.db
;   - `%LOCALAPPDATA%\kyclaw-updater` —— electron-updater 下载缓存
;   - `%APPDATA%\kyclaw-updater`     —— 防御性清理（部分版本/平台落在这里）
;   **不删** `%USERPROFILE%\kyclaw\工作区`（默认工作区里可能有用户自己的文件）。
;
; 静默 / 自动更新：
;   electron-updater 升级时会静默调 Uninstall.exe。升级不是「用户要卸载」，默认**保留**数据；
;   无人值守卸载要删数据需显式传 electron-builder 约定的 `--delete-app-data`。
;   `${isUpdated}` 成立时也一律保留（双保险）。

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

; 这些只属于**卸载器**编译（BUILD_UNINSTALLER）：安装器编译里定义会产生
; "variable not referenced" 警告，而 electron-builder 用 -WX（警告当错误）。
!ifdef BUILD_UNINSTALLER

Var unKyclawDeleteHistory        ; "1" = 本次卸载删除历史数据
Var unKyclawDeleteHistoryBox     ; 勾选框句柄

!macro customUnInit
  StrCpy $unKyclawDeleteHistory "0"
!macroend

; 把默认卸载欢迎页替换成「是否同时删除本地历史数据」选择页。
; 页面函数放在宏里、随宏在卸载器分支展开 —— 那时 MUI2 已 include，能直接用 MUI_HEADER_TEXT。
!macro customUnWelcomePage
  UninstPage custom un.kyclawDeleteHistoryPageCreate un.kyclawDeleteHistoryPageLeave

  Function un.kyclawDeleteHistoryPageCreate
    ; 自动更新走静默卸载；若被手动以 updated 参数拉起，也不显示选择页（一律保留数据）
    ${If} ${isUpdated}
      Abort
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "卸载 kyclaw" "选择是否同时删除本地历史数据"

    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0u 100% 26u "卸载前请选择：是否同时删除本机上的历史数据（会话记录、设置、加密密钥、日志、模型缓存）。"
    Pop $0

    ${NSD_CreateCheckbox} 0 32u 100% 24u "同时删除本地历史数据（默认勾选；取消勾选则保留，重装后还能用回会话与密钥）"
    Pop $unKyclawDeleteHistoryBox
    ${NSD_SetState} $unKyclawDeleteHistoryBox ${BST_CHECKED}
    StrCpy $unKyclawDeleteHistory "1"

    ${NSD_CreateLabel} 0 60u 100% 52u "删除位置：$APPDATA\kyclaw 与 $LOCALAPPDATA\kyclaw-updater。$\r$\n不会删除你的工作区文件夹（例如 %USERPROFILE%\kyclaw\工作区）里的文件。"
    Pop $0

    nsDialogs::Show
  FunctionEnd

  Function un.kyclawDeleteHistoryPageLeave
    ${NSD_GetState} $unKyclawDeleteHistoryBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $unKyclawDeleteHistory "1"
    ${Else}
      StrCpy $unKyclawDeleteHistory "0"
    ${EndIf}
  FunctionEnd
!macroend

!macro customUnInstall
  ; 自动更新：保留数据（升级不是卸载）
  ${If} ${isUpdated}
    StrCpy $unKyclawDeleteHistory "0"
  ${ElseIf} ${Silent}
    ; 静默卸载：默认保留；只有显式 --delete-app-data 才删
    ${GetParameters} $R0
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${IfNot} ${Errors}
      StrCpy $unKyclawDeleteHistory "1"
    ${Else}
      StrCpy $unKyclawDeleteHistory "0"
    ${EndIf}
  ${EndIf}

  ${If} $unKyclawDeleteHistory == "1"
    SetShellVarContext current
    RMDir /r "$APPDATA\kyclaw"
    RMDir /r "$APPDATA\kyclaw-updater"
    RMDir /r "$LOCALAPPDATA\kyclaw-updater"
    DetailPrint "已删除本地历史数据（$APPDATA\kyclaw、更新缓存）"
  ${EndIf}
!macroend

!endif ; BUILD_UNINSTALLER
