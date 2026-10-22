; A running program cannot be replaced on Windows, so an update stops the host service, if this
; computer has one, while hostd.exe is replaced, and starts it again (docs/adr/0022-host-mode.md).
; On a computer that does not serve, sc.exe finds no service and nothing happens.

!macro NSIS_HOOK_PREINSTALL
  nsExec::Exec 'sc.exe stop GlazeVaultHost'
  Sleep 3000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  nsExec::Exec 'sc.exe start GlazeVaultHost'
!macroend

; Removing the app removes the service with it, as it would no longer have a program to run. The
; host's store stays in ProgramData, for an admin to bring back.
!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'sc.exe stop GlazeVaultHost'
  Sleep 3000
  nsExec::Exec 'sc.exe delete GlazeVaultHost'
!macroend
