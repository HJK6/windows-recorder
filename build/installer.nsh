; Custom NSIS include for electron-builder (referenced from package.json build.nsis.include).
;
; Best-effort pre-grant of the Windows microphone consent for desktop apps, so a
; freshly-installed POC can capture without the user first toggling a privacy
; switch. This writes the per-user (HKCU) ConsentStore value only.
;
; IMPORTANT: this is BEST EFFORT ONLY. It is a semi-undocumented mechanism that
; a Windows update can reset, and it does not cover machine-wide or MDM-managed
; policy. The production fleet answer is Intune/GPO (Privacy CSP
; LetAppsAccessMicrophone = Force Allow) applied at enrollment — see
; docs/permission_model.md. The app also detects a denied state at runtime and
; guides the user, so capture is never a silent failure even if this no-ops.
;
; v1 records screen + microphone only (no webcam), so only the microphone
; consent is touched here.

!macro customInstall
  DetailPrint "HF Recorder: best-effort microphone consent pre-grant (per-user)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" "Value" "Allow"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged" "Value" "Allow"
!macroend
