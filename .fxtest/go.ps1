param([Parameter(Mandatory=$true)][string]$Script,[string]$Arg="")
$d="$env:TEMP\fxtest"
ssh -i "$d\id" -o UserKnownHostsFile="$d\kh" -o BatchMode=yes root@45.144.136.155 "mkdir -p /root/fxtest"
scp -q -i "$d\id" -o UserKnownHostsFile="$d\kh" -o BatchMode=yes "$PSScriptRoot\*.mjs" "$PSScriptRoot\*.sh" "$PSScriptRoot\*.py" root@45.144.136.155:/root/fxtest/ 2>&1 | ForEach-Object { "$_" }
ssh -i "$d\id" -o UserKnownHostsFile="$d\kh" -o BatchMode=yes -o ServerAliveInterval=15 root@45.144.136.155 "cd /root/fxtest && sed -i s/\r$// *.sh && bash ./$Script $Arg" 2>&1 | ForEach-Object { "$_" }
