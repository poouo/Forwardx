$d="$env:TEMP\fxtest"
ssh -i "$d\id" -o UserKnownHostsFile="$d\kh" -o BatchMode=yes root@45.144.136.155 "mkdir -p /root/fxtest"
scp -q -i "$d\id" -o UserKnownHostsFile="$d\kh" -o BatchMode=yes "$PSScriptRoot\*.mjs" "$PSScriptRoot\*.sh" root@45.144.136.155:/root/fxtest/ 2>&1 | ForEach-Object { "$_" }
"pushed"
