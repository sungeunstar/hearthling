@echo off
rem hearthling 상시 구동 — 더블클릭하면 최소화된 창에서 서버가 돌고 브라우저가 열린다.
rem 이미 떠 있으면 새로 띄우지 않고 기존 화면만 연다. 끄려면 최소화된 hearthling 창을 닫는다.
start "hearthling" /min node "%~dp0server\server.js"
