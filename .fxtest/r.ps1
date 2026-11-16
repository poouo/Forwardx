param([Parameter(Mandatory=$true)][string]$Cmd)
$d="$env:TEMP\fxtest"
$Cmd = $Cmd -replace "`r",""
ssh -i "$d\id" -o UserKnownHostsFile="$d\kh" -o BatchMode=yes -o ServerAliveInterval=15 root@45.144.136.155 $Cmd 2>&1 | ForEach-Object { "$_" }
