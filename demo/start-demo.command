#!/bin/sh
cd "$(dirname "$0")/app" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 24를 설치한 뒤 다시 실행해 주세요: https://nodejs.org/'
  read -r answer
  exit 1
fi
node demo/start-demo.mjs
printf '\n종료하려면 Enter를 누르세요.\n'
read -r answer
