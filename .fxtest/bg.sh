# usage: bash bg.sh <script> ; runs it detached, log in <script>.log
nohup bash "./$1" > "./$1.log" 2>&1 &
echo "started $1 pid=$!"
