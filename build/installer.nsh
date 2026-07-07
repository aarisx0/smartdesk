; installer.nsh — Custom NSIS hooks for SmartDesk AI
; Fixes: "browse for exe" dialog caused by spaces in executable name
; This file is auto-included by electron-builder when present in build/

!macro customInstall
  ; Nothing extra needed on install
!macroend

!macro customUnInstall
  ; Nothing extra needed on uninstall
!macroend

; Override the finish page launch — use quoted path to handle spaces in name
!macro customWelcomePage
!macroend

!macro customRunAfterFinish
  ; Launch using quoted Exec so spaces in path are handled correctly
  Exec '"$INSTDIR\SmartDesk AI.exe"'
!macroend
