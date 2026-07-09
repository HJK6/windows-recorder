; Standalone NSIS installer for HF Recorder.
;
; Compiled with native makensis (Linux) — NO wine required, unlike
; electron-builder's NSIS target (which runs the installer under wine to
; generate the uninstaller). This hand-rolled script also gives full control
; over the microphone ConsentStore pre-grant, which is a core POC feature.
;
; Build from the repo root:
;   ./node_modules/.bin/electron-builder --win --dir     ; -> dist/win-unpacked
;   makensis build/installer-standalone.nsi              ; -> dist/HFRecorder-Setup-<ver>.exe
;
; Per-user install (RequestExecutionLevel user): no admin prompt, installs to
; %LOCALAPPDATA%\Programs\HFRecorder, writes only HKCU. Matches the POC's
; per-user install decision.

Unicode true

!define APPNAME "HFRecorder"
!define DISPLAYNAME "HF Recorder"
!define COMPANY "Vamshi Gujju"
!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef SRC
  !define SRC "dist/win-unpacked"
!endif
!ifndef OUTFILE
  !define OUTFILE "dist\HFRecorder-Setup-0.1.0.exe"
!endif
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"

Name "${DISPLAYNAME}"
OutFile "${OUTFILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
ShowInstDetails show
ShowUninstDetails show

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "${SRC}/*"

  ; --- Best-effort Windows microphone consent pre-grant (per-user) ---------
  ; Core POC feature: reduce first-run capture friction so a freshly-installed
  ; app can record without the user first toggling a privacy switch. BEST
  ; EFFORT ONLY — a Windows update can reset it, and it is not machine-wide.
  ; Production fleets provision this via Intune/GPO (Privacy CSP) at enrollment;
  ; see docs/permission_model.md. v1 records screen + mic only, so only the
  ; microphone consent is touched.
  DetailPrint "Best-effort microphone consent pre-grant (per-user, HKCU)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" "Value" "Allow"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged" "Value" "Allow"

  ; --- Shortcuts -----------------------------------------------------------
  CreateDirectory "$SMPROGRAMS\${DISPLAYNAME}"
  CreateShortcut "$SMPROGRAMS\${DISPLAYNAME}\${DISPLAYNAME}.lnk" "$INSTDIR\HFRecorder.exe"
  CreateShortcut "$DESKTOP\${DISPLAYNAME}.lnk" "$INSTDIR\HFRecorder.exe"

  ; --- Uninstaller + Add/Remove Programs (per-user, HKCU) ------------------
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayName" "${DISPLAYNAME}"
  WriteRegStr HKCU "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTKEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${DISPLAYNAME}\${DISPLAYNAME}.lnk"
  RMDir "$SMPROGRAMS\${DISPLAYNAME}"
  Delete "$DESKTOP\${DISPLAYNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINSTKEY}"
  ; Note: we intentionally do NOT revert the mic ConsentStore on uninstall —
  ; the user may rely on it for other apps; reverting could surprise them.
SectionEnd
