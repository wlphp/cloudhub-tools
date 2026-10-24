; Tauri NSIS 安装钩子。
; 产品由 "CloudHub Tools" 更名为 "云枢工具箱" 后，旧版（≤0.1.82）的卸载信息仍登记在
; 旧 PRODUCTNAME 对应的注册表键下，新版安装器按新名检索不到旧安装目录，会在系统里
; 留下双份安装。此钩子在复制文件前检测旧版：静默运行旧卸载器、沿用原安装目录并清理
; 旧快捷方式与旧键；未安装过旧版时全部操作自动跳过。
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\CloudHub Tools" "UninstallString"
  ReadRegStr $R1 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\CloudHub Tools" "InstallLocation"
  ${If} $R0 != ""
    ${AndIf} $R1 != ""
    ; 注册表中的 InstallLocation 带引号，剥掉后作为本次安装目录
    StrCpy $R2 $R1 1
    ${If} $R2 == "$\""
      StrLen $R3 $R1
      IntOp $R3 $R3 - 2
      StrCpy $R1 "$R1" $R3 1
    ${EndIf}
    ExecWait '$R0 /P _?="$R1"'
    StrCpy $INSTDIR $R1
    Delete "$DESKTOP\CloudHub Tools.lnk"
    DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\CloudHub Tools"
    DeleteRegKey SHCTX "Software\wanglei\CloudHub Tools"
  ${EndIf}
!macroend
