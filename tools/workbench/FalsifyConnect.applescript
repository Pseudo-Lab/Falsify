-- Per-user falsify:// handler. The checkout path is not compiled into this script.
-- AppleScript open location: https://developer.apple.com/library/archive/documentation/AppleScript/Conceptual/AppleScriptLangGuide/reference/ASLR_cmds.html
-- The bundle's CFBundleURLTypes claim is what Launch Services uses to deliver the URL.
-- quoted form of is the shell quoting from Technical Note TN2065. Browser and macOS approval stay outside this script.
on open location theURL
	set linkText to theURL as text
	set pathFile to POSIX path of (path to resource "falsify-script-path.txt")
	set scriptPath to paragraph 1 of (read POSIX file pathFile)
	do shell script "/bin/bash " & quoted form of scriptPath & " " & quoted form of linkText
end open location
